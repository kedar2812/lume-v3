import { createHash } from "node:crypto";
import { moduleIncluded, readWebhook, relayCheck } from "@lume/core";
import { schema } from "@lume/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../app";
import { isLocked } from "../../licence/enforce";

const E = schema.whatsappEvents;
const N = schema.whatsappNumbers;
const BODY_LIMIT = 3 * 1024 * 1024;
const REPLAY_MS = 10 * 60_000;
export const eventContext = (wamid: string, kind: string) => `whatsapp-event:${wamid}:${kind}`;
const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `POST /whatsapp/in` (spec 2026-10-18 §3.3): Meta's deliveries, passed on by the relay and signed with this instance's
 * token. Public and outside the session scope. Each message is kept once — Meta retries until it hears 200, so the
 * same (wamid, kind) twice is one row — encrypted while it waits, then queued. When this LUME can't take messages
 * (WhatsApp off, out of the plan, read-only, a number it doesn't have) it still says 200 and keeps nothing: a non-2xx
 * would only make Meta try again for days.
 */
export async function whatsappReceiveRoutes(app: FastifyInstance, d: AppDeps) {
  const db = drizzle(d.pool, { schema }); // an intake table: no row-level security (as webhook_events)
  // A forward works once: the same signed body sent again within its five minutes is refused. Held here, in this
  // process (one API per LUME); a replay after a restart is still one event (the wamid), so nothing is lost by it.
  const seen = new Map<string, number>();

  app.post(
    "/whatsapp/in",
    { config: { public: true, csrf: false, db: false }, bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const token = d.googleOAuth?.relayToken;
      if (!token) return reply.code(404).send({ error: "not_found" });
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const now = d.clock().getTime();
      const sig = header(req.headers["x-lume-signature"]);
      if (relayCheck(token, header(req.headers["x-lume-timestamp"]), sig, raw, now) !== "ok")
        return reply.code(401).send({ error: "unauthorized" });
      for (const [k, until] of seen) if (until < now) seen.delete(k);
      const once = createHash("sha256").update(sig!).digest("hex");
      if (seen.has(once)) return reply.code(401).send({ error: "unauthorized" });
      seen.set(once, now + REPLAY_MS);

      const ok = () => reply.code(200).send({ ok: true });
      if (isLocked(req.server.licence.view().state)) return ok();
      const [s] = await db
        .select({ i: schema.settings.integrations })
        .from(schema.settings)
        .where(eq(schema.settings.id, 1));
      if (!s?.i.whatsapp?.enabled || !moduleIncluded(req.server.licence.view().plan, "whatsapp")) return ok();

      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return ok();
      }
      const events = readWebhook(body);
      if (!events.length) return ok();
      const known = new Set(
        (
          await db
            .select({ id: N.phoneNumberId })
            .from(N)
            .where(
              and(
                inArray(N.phoneNumberId, [...new Set(events.map((e) => e.phoneNumberId))]),
                ne(N.status, "disconnected"),
              ),
            )
        ).map((r) => r.id),
      );
      const queued: number[] = [];
      for (const ev of events) {
        if (!known.has(ev.phoneNumberId)) continue;
        const [row] = await db
          .insert(E)
          .values({
            phoneNumberId: ev.phoneNumberId,
            wamid: ev.wamid,
            kind: ev.kind,
            eventEnc: d.keyring.encrypt(JSON.stringify(ev), eventContext(ev.wamid, ev.kind)),
            status: "queued",
          })
          .onConflictDoNothing({ target: [E.wamid, E.kind] })
          .returning({ id: E.id });
        if (row) queued.push(row.id);
      }
      // Kept: if the queue can't take one now, the sweep will (queue.ts), so Meta hears 200 either way.
      for (const id of queued)
        await d.whatsapp
          ?.enqueue(id)
          .catch((err: unknown) => req.log.error({ err }, "couldn't queue a WhatsApp event"));
      return ok();
    },
  );
}
