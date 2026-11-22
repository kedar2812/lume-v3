import { createHash } from "node:crypto";
import { eventKey, moduleIncluded, readInstagramWebhook } from "@lume/core";
import { schema } from "@lume/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../app";
import { isLocked } from "../../licence/enforce";
import { fromRelay } from "./relay-routes";

const E = schema.instagramEvents;
const A = schema.instagramAccounts;
const BODY_LIMIT = 3 * 1024 * 1024;
const REPLAY_MS = 10 * 60_000;
export const igEventContext = (accountIgId: string, key: string) => `instagram-event:${accountIgId}:${key}`;
const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `POST /instagram/in` (NEW_FEATURES_PLAN §4.2): Meta's deliveries for this LUME's accounts, passed on by the relay and
 * signed with this instance's token. Public and outside the session scope. Each delivery is kept once (Meta retries
 * for up to 36 hours, so the same account and key twice is one row), encrypted while it waits, then queued. When this
 * LUME can't take them (Instagram off, out of the plan, read-only, an account it doesn't have) it still says 200 and
 * keeps nothing: anything else would only make Meta try again for days.
 */
export async function instagramReceiveRoutes(app: FastifyInstance, d: AppDeps) {
  const db = drizzle(d.pool, { schema }); // an intake table: no row-level security (as whatsapp_events)
  // A forward works once: the same signed body again within its five minutes is refused. A replay after a restart is
  // still one event (its key), so nothing is lost by keeping this in memory.
  const seen = new Map<string, number>();

  app.post(
    "/instagram/in",
    { config: { public: true, csrf: false, db: false }, bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!fromRelay(req, d, raw)) return reply.code(401).send({ error: "unauthorized" });
      const now = d.clock().getTime();
      for (const [k, until] of seen) if (until < now) seen.delete(k);
      const once = createHash("sha256")
        .update(header(req.headers["x-lume-signature"]) ?? "")
        .digest("hex");
      if (seen.has(once)) return reply.code(401).send({ error: "unauthorized" });
      seen.set(once, now + REPLAY_MS);

      const ok = () => reply.code(200).send({ ok: true });
      if (isLocked(req.server.licence.view().state)) return ok();
      const [s] = await db
        .select({ i: schema.settings.integrations })
        .from(schema.settings)
        .where(eq(schema.settings.id, 1));
      if (!s?.i.instagram?.enabled || !moduleIncluded(req.server.licence.view().plan, "instagram"))
        return ok();

      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return ok();
      }
      const events = readInstagramWebhook(body);
      if (!events.length) return ok();
      const known = new Set(
        (
          await db
            .select({ id: A.igUserId })
            .from(A)
            .where(
              and(
                inArray(A.igUserId, [...new Set(events.map((e) => e.accountId))]),
                ne(A.status, "disconnected"),
              ),
            )
        ).map((r) => r.id),
      );
      const queued: number[] = [];
      for (const ev of events) {
        if (!known.has(ev.accountId)) continue;
        const key = eventKey(ev);
        const [row] = await db
          .insert(E)
          .values({
            accountIgId: ev.accountId,
            eventKey: key,
            kind: ev.kind,
            eventEnc: d.keyring.encrypt(JSON.stringify(ev), igEventContext(ev.accountId, key)),
            status: "queued",
          })
          .onConflictDoNothing({ target: [E.accountIgId, E.eventKey] })
          .returning({ id: E.id });
        if (row) queued.push(row.id);
      }
      // Kept: if the queue can't take one now, the minute sweep will, so Meta hears 200 either way.
      for (const id of queued)
        await d.instagram
          ?.enqueue(id)
          .catch((err: unknown) => req.log.error({ err }, "couldn't queue an Instagram event"));
      return ok();
    },
  );
}
