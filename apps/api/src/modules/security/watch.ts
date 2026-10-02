import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { PAUSED_MESSAGE, breached, isWatched, mergeAnomaly, nearLimit, type RuleId } from "@lume/core";
import type { SecuritySettings } from "@lume/db";
import { raiseAlert } from "./alerts";
import { countFor } from "./counts";
import { suspendUser, tellAdmins } from "./suspend";

declare module "fastify" {
  interface FastifyInstance {
    /** What the watch needs beyond the request (6A): the pool to tell admins on, once committed, and the clock. */
    watch: { pool: pg.Pool; clock: () => Date };
  }
}

export type WatchOutcome = { outcome: "ok" | "suspended"; nearLimit: boolean };
const QUIET: WatchOutcome = { outcome: "ok", nearLimit: false };

/** The refusal a paused person gets, from the act that crossed the line onwards (spec §2.5). */
export const SUSPENDED_BODY = { error: { code: "SUSPENDED", message: PAUSED_MESSAGE } } as const;

/**
 * The inline check (spec §2.3): run right after a watched act's own audit row, in its transaction, so the count
 * includes this act. A breach raises (or grows) the alert; a pause rule also suspends them. The caller then
 * answers 403 SUSPENDED without throwing (plan ruling R4), so the pause, the alert and the act's audit row all
 * commit while the contact or lead stays unsent. Nobody who sees every contact, and never the owner, is counted.
 */
export async function watchAct(req: FastifyRequest, rule: RuleId): Promise<WatchOutcome> {
  const actor = req.actor;
  if (!actor || !isWatched(actor)) return QUIET;
  const { rows } = await req.db.execute(sql`SELECT timezone, security FROM settings WHERE id = 1`);
  const s = rows[0] as { timezone: string; security: SecuritySettings } | undefined;
  if (!s) return QUIET;
  const setting = mergeAnomaly(s.security?.anomaly)[rule];
  if (setting.action === "off") return QUIET;

  const { observed } = await countFor(req.db, actor.userId, rule, s.timezone);
  const pauses = setting.action === "suspend";
  if (!breached(observed, setting.threshold))
    return { outcome: "ok", nearLimit: pauses && nearLimit(observed, setting.threshold) };

  const alert = await raiseAlert(req.db, {
    userId: actor.userId,
    rule,
    observed,
    threshold: setting.threshold,
    action: pauses ? "suspended" : "alerted",
    tz: s.timezone,
  });
  if (pauses) {
    await suspendUser(req.db, actor.userId, req.server.watch.clock(), alert.id);
    const cache = req.server.actorCache;
    req.afterCommit(() => cache.invalidate(actor.userId));
  }
  if (alert.isNew) {
    const { pool } = req.server.watch;
    const log = req.log;
    req.afterCommit(
      () =>
        void tellAdmins(pool, alert.id).catch((err: unknown) => log.error({ err }, "couldn't tell admins")),
    );
  }
  return { outcome: pauses ? "suspended" : "ok", nearLimit: false };
}
