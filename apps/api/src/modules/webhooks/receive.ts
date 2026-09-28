import { createHash } from "node:crypto";
import { schema } from "@lume/db";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppDeps } from "../../app";
import { createLimiter } from "./limits";
import { parseBody } from "./payload";
import { checkSignature, checkToken, openWebhook } from "./secret";

const S = schema.leadSources;
const E = schema.webhookEvents;
const BODY_LIMIT = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Checked against for a source that doesn't exist, so a stranger's post takes the same time as a bad one. */
const DUMMY = "d".repeat(43);

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
  const reject = (id: string, reason: RejectReason) =>
    db
      .update(S)
      .set({ rejected: sql`${S.rejected} + 1`, lastRejectedReason: reason })
      .where(and(eq(S.id, id), eq(S.type, "webhook")));

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
          if (UUID.test(id)) await reject(id, "too_large");
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

      // 1. Rate.
      const rate = limiter.take(UUID.test(id) ? id : "unknown");
      if (!rate.ok) {
        if (UUID.test(id)) await reject(id, "rate_limited");
        return reply.code(429).header("retry-after", String(rate.retryAfterSec)).send({ error: "slow_down" });
      }

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
        void (token ? checkToken(DUMMY, token) : checkSignature(DUMMY, ts, sig, raw, now));
        return unauthorized(reply);
      }

      // 3. Auth, by the source's mode.
      const cfg = openWebhook(d.keyring, id, s.configEnc!);
      const ok =
        cfg.mode === "token" ? checkToken(cfg.secret, token) : checkSignature(cfg.secret, ts, sig, raw, now);
      if (!ok) {
        await reject(id, cfg.mode === "token" ? "bad_token" : "bad_signature");
        return unauthorized(reply);
      }
      if (s.status === "paused")
        return reply.code(503).header("retry-after", "3600").send({ error: "paused" });

      // 4. Parse.
      const body = parseBody(raw, req.headers["content-type"]);
      if (!body.ok) {
        await reject(id, body.code.toLowerCase() as RejectReason);
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
          payloadEnc: d.keyring.encrypt(raw.toString("utf8"), `webhook-event:${id}:${eventKey}`),
          status,
        })
        .onConflictDoNothing({ target: [E.sourceId, E.eventKey] })
        .returning({ id: E.id });
      await db
        .update(S)
        .set({ lastEventAt: new Date(now) })
        .where(eq(S.id, id));
      if (!row) return reply.code(202).send({ accepted: true, duplicate: true });
      if (status === "queued") await d.webhooks?.enqueue(row.id);
      return reply.code(202).send({ accepted: true });
    },
  );
}
