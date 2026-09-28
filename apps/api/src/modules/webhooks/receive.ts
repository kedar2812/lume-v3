import { createHash } from "node:crypto";
import { schema } from "@lume/db";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppDeps } from "../../app";
import { createLimiter } from "./limits";
import { parseBody } from "./payload";
import { eventContext } from "./process";
import { checkSignature, checkToken, openWebhook, sealWebhook } from "./secret";

const S = schema.leadSources;
const E = schema.webhookEvents;
const BODY_LIMIT = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Opened and checked for a source that doesn't exist, so a stranger's post costs what a bad one does. */
const DUMMY = "d".repeat(43);
const DUMMY_ID = "00000000-0000-7000-8000-000000000000";

export type RejectReason =
  | "bad_signature"
  | "bad_token"
  | "rate_limited"
  | "too_large"
  | "bad_json"
  | "not_object"
  | "unsupported_type";

const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: "unauthorized" });

/**
 * `POST /webhooks/in/:id` (2C spec §4). Public and outside the session scope: no cookie, CSRF or request
 * transaction. It answers at once and never says which check failed, nor names the source.
 */
export async function receiveRoutes(app: FastifyInstance, d: AppDeps) {
  const db = drizzle(d.pool, { schema }); // the intake tables have no row-level security (2A amendment 5)
  const limiter = d.webhooks?.limiter ?? createLimiter({ perSource: 60, perInstance: 600, windowMs: 60_000 });
  const dummy = sealWebhook(d.keyring, DUMMY_ID, { mode: "signed", secret: DUMMY, preset: "website" });
  // Counted after the answer, never before it: the answer takes the same time either way (final review, 5).
  const reject = (id: string, reason: RejectReason) =>
    void db
      .update(S)
      .set({ rejected: sql`${S.rejected} + 1`, lastRejectedReason: reason })
      .where(and(eq(S.id, id), eq(S.type, "webhook")))
      .catch((err: unknown) => app.log.warn({ err }, "couldn't count a refused webhook post"));
  const slowDown = (reply: FastifyReply, retryAfterSec: number) =>
    reply.code(429).header("retry-after", String(retryAfterSec)).send({ error: "slow_down" });

  // Every body arrives as raw bytes: the signature covers them exactly, and parseBody decides the type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: BODY_LIMIT }, (_r, body, done) =>
    done(null, body),
  );

  app.post<{ Params: { id: string } }>(
    "/webhooks/in/:id",
    {
      config: { public: true, csrf: false, db: false },
      bodyLimit: BODY_LIMIT,
      errorHandler: async (err: { statusCode?: number }, req, reply) => {
        const id = (req.params as { id?: string }).id ?? "";
        if (err.statusCode === 413) {
          // Only while under the gate: a flood of big bodies costs no database work at all.
          if (UUID.test(id) && limiter.gate().ok) reject(id, "too_large");
          return reply.code(413).send({ error: "too_large" });
        }
        req.log.warn({ err }, "webhook post failed");
        return reply.code(err.statusCode && err.statusCode < 500 ? 400 : 500).send({ error: "bad_request" });
      },
    },
    async (req, reply) => {
      const id = req.params.id;
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const token = header(req.headers["x-lume-token"]);
      const ts = header(req.headers["x-lume-timestamp"]);
      const sig = header(req.headers["x-lume-signature"]);
      const now = d.clock().getTime();

      // 1. The gate: a flood is turned away before anything is looked up.
      const gate = limiter.gate();
      if (!gate.ok) return slowDown(reply, gate.retryAfterSec);

      // 2. The source, and the module switch.
      const [s] = UUID.test(id)
        ? await db
            .select({ status: S.status, type: S.type, configEnc: S.configEnc, archivedAt: S.archivedAt })
            .from(S)
            .where(eq(S.id, id))
        : [];
      const [settings] = await db
        .select({ i: schema.settings.integrations })
        .from(schema.settings)
        .where(eq(schema.settings.id, 1));
      const known =
        s &&
        s.type === "webhook" &&
        s.configEnc &&
        !s.archivedAt &&
        s.status !== "archived" &&
        settings?.i.webhooks?.enabled;
      if (!known) {
        // The same work as a real one with a bad secret: open a sealed config, then check against it.
        const c = openWebhook(d.keyring, DUMMY_ID, dummy);
        void (token ? checkToken(c.secret, token) : checkSignature(c.secret, ts, sig, raw, now));
        return unauthorized(reply);
      }

      // 2b. This webhook's own share, spent before its secret is checked (a flood on one address stays cheap).
      const mine = limiter.source(id);
      if (!mine.ok) {
        if (mine.first) reject(id, "rate_limited");
        return slowDown(reply, mine.retryAfterSec);
      }

      // 3. Auth, by the source's mode.
      const cfg = openWebhook(d.keyring, id, s.configEnc!);
      const ok =
        cfg.mode === "token" ? checkToken(cfg.secret, token) : checkSignature(cfg.secret, ts, sig, raw, now);
      if (!ok) {
        reject(id, cfg.mode === "token" ? "bad_token" : "bad_signature");
        return unauthorized(reply);
      }
      if (s.status === "paused")
        return reply.code(503).header("retry-after", "3600").send({ error: "paused" });

      // 3b. The instance's share (spec §2: 600 a minute), spent only by posts that proved themselves.
      const all = limiter.instance();
      if (!all.ok) {
        if (all.first) reject(id, "rate_limited");
        return slowDown(reply, all.retryAfterSec);
      }

      // 4. Parse.
      const body = parseBody(raw, req.headers["content-type"]);
      if (!body.ok) {
        reject(id, body.code.toLowerCase() as RejectReason);
        return reply.code(body.status).send({ error: body.code.toLowerCase() });
      }

      // 5–6. Replay-safe accept: one row per (source, key), however many arrive at once.
      const given = header(req.headers["x-lume-event-id"])?.trim();
      const eventKey =
        given && given.length <= 200
          ? given
          : createHash("sha256")
              .update(given ?? raw)
              .digest("hex");
      const status = s.status === "draft" ? ("test" as const) : ("queued" as const);
      const [row] = await db
        .insert(E)
        .values({
          sourceId: id,
          eventKey,
          // Kept as the JSON it read as (a form's fields too), so processing needs no content type.
          payloadEnc: d.keyring.encrypt(JSON.stringify(body.value), eventContext(id, eventKey)),
          status,
        })
        .onConflictDoNothing({ target: [E.sourceId, E.eventKey] })
        .returning({ id: E.id });
      await db
        .update(S)
        .set({ lastEventAt: new Date(now) })
        .where(eq(S.id, id));
      if (!row) return reply.code(202).send({ accepted: true, duplicate: true });
      // The post is kept: if the queue can't take it now, the sweep will (queue.ts), so the sender hears 202.
      if (status === "queued")
        await d.webhooks
          ?.enqueue(row.id)
          .catch((err: unknown) => req.log.error({ err }, "couldn't queue a webhook post"));
      return reply.code(202).send({ accepted: true });
    },
  );
}
