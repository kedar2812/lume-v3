import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { sha256Hex } from "@lume/core";
import { schema } from "@lume/db";
import { HttpError, badRequest } from "./errors";

declare module "fastify" {
  interface FastifyContextConfig {
    /** false: never replay or store (responses that must not be persisted, e.g. revealed contacts). */
    idempotent?: boolean;
  }
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const KEY_RE = /^[A-Za-z0-9_-]{8,200}$/;
const TTL_MS = 24 * 3600_000;

/**
 * Report §4.4: a retried or double-clicked mutation with the same Idempotency-Key replays the first
 * successful response instead of running again. Keys are per user; the stored record is written in the
 * same transaction as the change (beforeCommit), so it exists exactly when the change does. Call after
 * dbContext (needs req.db); concurrent requests with one key are serialised by an advisory lock.
 */
export function idempotency(app: FastifyInstance): void {
  app.addHook("preHandler", async (req, reply) => {
    if (!MUTATING.has(req.method) || req.routeOptions.config?.idempotent === false || !req.actor) return;
    const key = req.headers["idempotency-key"];
    if (key === undefined) return;
    if (typeof key !== "string" || !KEY_RE.test(key))
      throw badRequest("BAD_IDEMPOTENCY_KEY", "Idempotency-Key must be 8-200 URL-safe characters");
    const userId = req.actor.userId;
    const route = `${req.method} ${req.routeOptions.url}`;
    const requestHash = sha256Hex(
      JSON.stringify({ params: req.params ?? null, query: req.query ?? null, body: req.body ?? null }),
    );

    await req.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))`);
    const where = and(eq(schema.idempotencyKeys.userId, userId), eq(schema.idempotencyKeys.key, key));
    const [prior] = await req.db.select().from(schema.idempotencyKeys).where(where);
    if (prior && Date.now() - prior.createdAt.getTime() > TTL_MS) {
      await req.db.delete(schema.idempotencyKeys).where(where);
    } else if (prior) {
      if (prior.route !== route || prior.requestHash !== requestHash) {
        throw new HttpError(
          422,
          "IDEMPOTENCY_MISMATCH",
          "This Idempotency-Key was already used for a different request",
        );
      }
      void reply.header("idempotent-replay", "true");
      return reply.code(prior.status).send(prior.response ?? undefined);
    }

    req.beforeCommit(async ({ statusCode, payload }) => {
      if (statusCode < 200 || statusCode >= 300) return; // failures are not remembered: retry is allowed
      const response =
        typeof payload === "string" && payload.length ? (JSON.parse(payload) as unknown) : null;
      await req.db
        .insert(schema.idempotencyKeys)
        .values({ userId, key, route, requestHash, status: statusCode, response });
    });
  });
}
