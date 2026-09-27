import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { schema } from "@lume/db";
import { applyRequestScope } from "../../db/context";
import type { ActorRecord } from "../../rbac/actor";

/**
 * The app as a job sees it. Per-app caches (the field registry's) are decorated inside the authenticated
 * scope, which the root app a job is handed doesn't have; a job gets its own, rebuilt as fields change.
 */
export function jobServer(app: FastifyInstance): FastifyInstance {
  if (app.hasDecorator("fieldRegistryCache")) return app;
  return Object.assign(Object.create(app) as FastifyInstance, { fieldRegistryCache: { value: null } });
}

/**
 * One transaction that looks like a request to the service code (db, actor, server, id, ip, log), so a job
 * writes leads through exactly the same functions a person does. `allLeads` widens lead_scope to 'all'
 * for this transaction only (the duplicate check must see every lead); everything else stays the actor's.
 */
export async function withJobRequest<T>(
  o: { app: FastifyInstance; pool: pg.Pool; actor: ActorRecord; requestId: string; allLeads: boolean },
  fn: (req: FastifyRequest) => Promise<T>,
): Promise<T> {
  const client = await o.pool.connect();
  const after: (() => void)[] = [];
  let out: T;
  try {
    await client.query("BEGIN");
    await applyRequestScope(client, o.actor);
    if (o.allLeads) await client.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const req = {
      db: drizzle(client, { schema }),
      actor: o.actor,
      server: o.app,
      id: o.requestId,
      ip: null,
      headers: {},
      log: o.app.log,
      afterCommit: (f: () => void) => void after.push(f),
      beforeCommit: () => {
        throw new Error("beforeCommit isn't available in a job");
      },
    } as unknown as FastifyRequest;
    out = await fn(req);
    await client.query("COMMIT");
  } catch (e) {
    // A connection whose rollback also failed is broken: destroy it rather than return it to the pool.
    const broken = await client.query("ROLLBACK").then(
      () => undefined,
      (err: Error) => err,
    );
    client.release(broken);
    throw e;
  }
  client.release();
  for (const f of after) f(); // only after a commit, and after the connection is back
  return out;
}
