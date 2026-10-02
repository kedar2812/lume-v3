import { sql, type SQL } from "drizzle-orm";
import { RULES, type RuleId } from "@lume/core";
import type { Db } from "../../db/context";

/**
 * Where a rule's window starts, on the database's clock — the same clock that stamps the audit rows it counts,
 * so a slow or skewed app clock can never shift a burst out of its window. Never before the person was last
 * restored (`watch_from`): the burst that paused someone can't pause them twice (Review Focus 4).
 */
export function windowStart(rule: RuleId, tz: string, userId: string | SQL): SQL {
  const from =
    RULES[rule].window === "hour"
      ? sql`now() - interval '60 minutes'`
      : sql`(date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;
  const who = typeof userId === "string" ? sql`${userId}::uuid` : userId;
  return sql`greatest(${from}, (SELECT watch_from FROM users WHERE id = ${who}))`;
}

/**
 * How many of a rule's acts one person did in its window (plan ruling R1: the audit rows each act already
 * writes). Leads opened counts different leads, so a drawer refetching one lead counts once.
 */
export async function countFor(
  db: Db,
  userId: string,
  rule: RuleId,
  tz: string,
): Promise<{ observed: number; windowStart: Date }> {
  const def = RULES[rule];
  const counted = def.distinct ? sql`count(DISTINCT entity_id)` : sql`count(*)`;
  const since = windowStart(rule, tz, userId);
  const { rows } = await db.execute(sql`
    WITH w AS (SELECT ${since} AS since)
    SELECT (SELECT ${counted}::int FROM audit_log, w
             WHERE actor_user_id = ${userId} AND action = ${def.audit} AND at > w.since) AS observed,
           w.since AS since
      FROM w`);
  const r = rows[0] as { observed: number; since: Date | string };
  return { observed: r.observed, windowStart: new Date(r.since) };
}
