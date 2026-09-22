import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { leadScope, type Actor } from "@lume/core";
import { schema } from "@lume/db";
import type { ActorRecord } from "../rbac/actor";

export type Db = NodePgDatabase<typeof schema>;
export type BeforeCommit = (r: { statusCode: number; payload: unknown }) => Promise<void>;

declare module "fastify" {
  interface FastifyContextConfig {
    /** false: this route gets no transaction (health checks, streaming). */
    db?: boolean;
  }
  interface FastifyRequest {
    db: Db;
    actor: ActorRecord | null;
    /** Run `fn` once this request's transaction has committed (never after a rollback). */
    afterCommit(fn: () => void): void;
    /** Run `fn` inside the transaction, just before COMMIT, knowing the response about to be sent. */
    beforeCommit(fn: BeforeCommit): void;
  }
}

type Held = {
  client: pg.PoolClient;
  failed: boolean;
  afterCommit: (() => void)[];
  beforeCommit: BeforeCommit[];
};
const held = new WeakMap<FastifyRequest, Held>();

/** Called by the error handler: a thrown error rolls the request's transaction back. */
export function markRequestFailed(req: FastifyRequest): void {
  const h = held.get(req);
  if (h) h.failed = true;
}

/** Row-level security reads these three settings (0007_rls_helpers.sql); is_local=true gives SET LOCAL semantics. */
export async function applyRequestScope(client: pg.PoolClient, actor: Actor): Promise<void> {
  await client.query(
    "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', $2, true), set_config('lume.team_member_ids', $3, true)",
    [actor.userId, leadScope(actor) ?? "", `{${actor.teamMemberIds.join(",")}}`],
  );
}

async function finish(req: FastifyRequest): Promise<void> {
  const h = held.get(req);
  if (!h) return;
  held.delete(req);
  try {
    await h.client.query(h.failed ? "ROLLBACK" : "COMMIT");
    h.client.release();
  } catch (e) {
    h.client.release(e as Error); // a broken connection is destroyed, never reused
    throw e;
  }
  if (!h.failed) for (const fn of h.afterCommit) fn();
}

/**
 * Every request runs in exactly one transaction (report §7.4). Throwing rolls back; returning (even a 4xx)
 * commits, so a failed login still records its throttle counters. Opens in preHandler, after the auth hook
 * (onRequest) has resolved the actor. Call directly on a scope (not via register) so the hooks apply to it.
 */
export function dbContext(app: FastifyInstance, opts: { pool: pg.Pool }): void {
  app.decorateRequest("db", null as unknown as Db);
  app.decorateRequest("actor", null);
  const register = (list: "afterCommit" | "beforeCommit") =>
    function (this: FastifyRequest, fn: (() => void) & BeforeCommit) {
      const h = held.get(this);
      if (!h) throw new Error(`${list} called outside a request transaction`);
      h[list].push(fn);
    };
  app.decorateRequest("afterCommit", register("afterCommit"));
  app.decorateRequest("beforeCommit", register("beforeCommit"));

  app.addHook("preHandler", async (req) => {
    if (req.routeOptions.config?.db === false) return;
    const client = await opts.pool.connect();
    held.set(req, { client, failed: false, afterCommit: [], beforeCommit: [] });
    await client.query("BEGIN");
    if (req.actor) await applyRequestScope(client, req.actor);
    req.db = drizzle(client, { schema });
  });
  app.addHook("onError", async (req) => markRequestFailed(req));
  app.addHook("onSend", async (req, reply, payload) => {
    const h = held.get(req);
    let out = payload;
    if (h && !h.failed) {
      try {
        for (const fn of h.beforeCommit) await fn({ statusCode: reply.statusCode, payload });
      } catch (err) {
        // The response hasn't left yet: turn it into an error and roll everything back.
        h.failed = true;
        req.log.error({ err }, "before-commit step failed");
        void reply.code(500).header("content-type", "application/json; charset=utf-8");
        out = JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
      }
    }
    await finish(req);
    return out;
  });
  // Safety nets: the connection always goes back, even if the socket dies mid-request.
  app.addHook("onResponse", finish);
  app.addHook("onRequestAbort", async (req) => {
    markRequestFailed(req);
    await finish(req);
  });
}
