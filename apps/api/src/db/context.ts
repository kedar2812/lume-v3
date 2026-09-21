import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { leadScope, type Actor } from "@lume/core";
import { schema } from "@lume/db";

export type Db = NodePgDatabase<typeof schema>;

declare module "fastify" {
  interface FastifyContextConfig {
    /** false: this route gets no transaction (health checks, streaming). */
    db?: boolean;
  }
  interface FastifyRequest {
    db: Db;
    actor: Actor | null;
  }
}

const held = new WeakMap<FastifyRequest, { client: pg.PoolClient; failed: boolean }>();

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
}

/**
 * Every request runs in exactly one transaction (report §7.4). Throwing rolls back; returning (even a 4xx)
 * commits, so a failed login still records its throttle counters. Opens in preHandler, after the auth hook
 * (onRequest) has resolved the actor. Call directly on a scope (not via register) so the hooks apply to it.
 */
export function dbContext(app: FastifyInstance, opts: { pool: pg.Pool }): void {
  app.decorateRequest("db", null as unknown as Db);
  app.decorateRequest("actor", null);

  app.addHook("preHandler", async (req) => {
    if (req.routeOptions.config?.db === false) return;
    const client = await opts.pool.connect();
    held.set(req, { client, failed: false });
    await client.query("BEGIN");
    if (req.actor) await applyRequestScope(client, req.actor);
    req.db = drizzle(client, { schema });
  });
  app.addHook("onError", async (req) => markRequestFailed(req));
  app.addHook("onSend", async (req, _reply, payload) => {
    await finish(req);
    return payload;
  });
  // Safety nets: the connection always goes back, even if the socket dies mid-request.
  app.addHook("onResponse", finish);
  app.addHook("onRequestAbort", async (req) => {
    markRequestFailed(req);
    await finish(req);
  });
}
