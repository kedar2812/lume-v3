import { createHash } from "node:crypto";
import { schema } from "@lume/db";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppDeps } from "../../app";
import { createLimiter } from "../webhooks/limits";
import { eventContext } from "../webhooks/process";
import type { RejectReason } from "../webhooks/receive";
import { CALENDLY_DEFAULTS, openCalendly, sealCalendly } from "./config";
import { calendlySignatureCheck } from "./signature";

const S = schema.leadSources;
const E = schema.webhookEvents;
const BODY_LIMIT = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUMMY_ID = "00000000-0000-7000-8000-000000000001";
/** What LUME does with a booking (spec §3); Calendly's other events are acknowledged and let go. */
export const CALENDLY_KEPT = new Set(["invitee.created", "invitee.canceled"]);

const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: "unauthorized" });

/**
 * `POST /webhooks/calendly/:id` (5B, spec §3). Public, in the same open scope as 2C's posts (its raw-body
 * parser and licence guard apply). It answers at once and never says which check failed.
 */
export async function calendlyReceiveRoutes(app: FastifyInstance, d: AppDeps) {
  const db = drizzle(d.pool, { schema }); // the intake tables have no row-level security (2A amendment 5)
  const limiter = d.webhooks?.limiter ?? createLimiter({ perSource: 60, perInstance: 600, windowMs: 60_000 });
  const dummy = sealCalendly(d.keyring, DUMMY_ID, {
    token: "",
    signingKey: "d".repeat(43),
    subscription: "",
    scope: "user",
    organization: "",
    user: "",
    account: { name: "", email: "" },
    settings: CALENDLY_DEFAULTS,
  });
  const reject = (id: string, reason: RejectReason) =>
    void db
      .update(S)
      .set({ rejected: sql`${S.rejected} + 1`, lastRejectedReason: reason })
      .where(and(eq(S.id, id), eq(S.type, "calendly")))
      .catch((err: unknown) => app.log.warn({ err }, "couldn't count a refused Calendly post"));
  const slowDown = (reply: FastifyReply, retryAfterSec: number) =>
    reply.code(429).header("retry-after", String(retryAfterSec)).send({ error: "slow_down" });

  app.post<{ Params: { id: string } }>(
    "/webhooks/calendly/:id",
    { config: { public: true, csrf: false, db: false }, bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const id = req.params.id;
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const header = req.headers["calendly-webhook-signature"];
      const sig = Array.isArray(header) ? header[0] : header;
      const now = d.clock().getTime();

      const gate = limiter.gate();
      if (!gate.ok) return slowDown(reply, gate.retryAfterSec);
      const [s] = UUID.test(id)
        ? await db
            .select({ status: S.status, type: S.type, configEnc: S.configEnc })
            .from(S)
            .where(eq(S.id, id))
        : [];
      if (!s || s.type !== "calendly" || !s.configEnc || s.status === "archived") {
        // The same work as a real one with a bad signature.
        void calendlySignatureCheck(openCalendly(d.keyring, DUMMY_ID, dummy).signingKey, sig, raw, now);
        return unauthorized(reply);
      }
      const mine = limiter.source(id);
      if (!mine.ok) {
        if (mine.first) reject(id, "rate_limited");
        return slowDown(reply, mine.retryAfterSec);
      }
      const cfg = openCalendly(d.keyring, id, s.configEnc);
      const check = calendlySignatureCheck(cfg.signingKey, sig, raw, now);
      if (check !== "ok") {
        reject(id, check === "stale" ? "stale_timestamp" : "bad_signature");
        return unauthorized(reply);
      }
      const all = limiter.instance();
      if (!all.ok) {
        if (all.first) reject(id, "rate_limited");
        return slowDown(reply, all.retryAfterSec);
      }

      let body: { event?: unknown; payload?: { uri?: unknown } } | null = null;
      try {
        body = JSON.parse(raw.toString("utf8")) as typeof body;
      } catch {
        body = null;
      }
      const event = typeof body?.event === "string" ? body.event : "";
      const uri = typeof body?.payload?.uri === "string" ? body.payload.uri : "";
      if (!body || typeof body !== "object" || !event) {
        reject(id, "bad_json");
        return reply.code(400).send({ error: "bad_json" });
      }
      if (!CALENDLY_KEPT.has(event) || !uri) return reply.code(202).send({ accepted: true, ignored: true });

      // One row per booking event, however often Calendly delivers it; a signature works once.
      const eventKey = `${event}:${uri}`.slice(0, 500);
      const kept = await db.transaction(async (tx) => {
        const first = await tx.execute(sql`
          INSERT INTO webhook_signatures (source_id, signature_hash)
          VALUES (${id}, ${createHash("sha256").update(sig!).digest()})
          ON CONFLICT DO NOTHING RETURNING 1`);
        if (!first.rows.length) return null;
        const [r] = await tx
          .insert(E)
          .values({
            sourceId: id,
            eventKey,
            payloadEnc: d.keyring.encrypt(JSON.stringify(body), eventContext(id, eventKey)),
            status: "queued",
          })
          .onConflictDoNothing({ target: [E.sourceId, E.eventKey] })
          .returning({ id: E.id });
        return r ?? null;
      });
      await db
        .update(S)
        .set({ lastEventAt: new Date(now) })
        .where(eq(S.id, id));
      if (!kept) return reply.code(202).send({ accepted: true, duplicate: true });
      await d.webhooks
        ?.enqueue(kept.id)
        .catch((err: unknown) => req.log.error({ err }, "couldn't queue a Calendly post"));
      return reply.code(202).send({ accepted: true });
    },
  );
}
