import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { ActorCache } from "./cache";

declare module "fastify" {
  interface FastifyInstance {
    actorCache: ActorCache;
  }
}

/**
 * Announce that a user's (or, without an id, everyone's) access changed.
 * - pg_notify is delivered on COMMIT only, so a rolled-back change never busts any cache, and every
 *   API instance hears it.
 * - This instance also drops its own entry right after commit, so the caller's very next request
 *   sees the change even if the notification hasn't arrived yet.
 */
export async function notifyRbac(req: FastifyRequest, userId?: string): Promise<void> {
  await req.db.execute(sql`SELECT pg_notify('lume_rbac', ${userId ?? ""})`);
  const cache = req.server.actorCache;
  req.afterCommit(() => cache.invalidate(userId));
}
