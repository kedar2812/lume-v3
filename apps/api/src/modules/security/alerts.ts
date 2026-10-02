import { sql } from "drizzle-orm";
import { RULES, newId, type RuleId } from "@lume/core";
import type { Db } from "../../db/context";
import { windowStart } from "./counts";
import { lumeAudit } from "./lume-audit";

export type RaisedAlert = { id: string; isNew: boolean };

/**
 * One alert per person, rule and window (plan ruling R3). An open alert still inside the rule's window grows:
 * the higher count, the later end, and "suspended" once LUME paused them. Otherwise a new one, audited as
 * LUME's own act. Two requests crossing the line at once are taken in turn (an advisory lock per person
 * and rule), so they make one alert, not two.
 */
export async function raiseAlert(
  db: Db,
  a: {
    userId: string;
    rule: RuleId;
    observed: number;
    threshold: number;
    action: "alerted" | "suspended";
    tz: string;
  },
): Promise<RaisedAlert> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('lume.watch'), hashtext(${a.userId + a.rule}))`);
  const since = windowStart(a.rule, a.tz, a.userId);
  const { rows: open } = await db.execute(sql`
    UPDATE security_alerts
       SET observed = greatest(observed, ${a.observed}),
           window_end = now(),
           action = CASE WHEN ${a.action} = 'suspended' THEN 'suspended' ELSE action END
     WHERE id = (SELECT id FROM security_alerts
                  WHERE user_id = ${a.userId} AND rule = ${a.rule} AND status = 'open'
                    AND window_end > (SELECT ${since})
                  ORDER BY created_at DESC LIMIT 1)
    RETURNING id`);
  if (open[0]) return { id: (open[0] as { id: string }).id, isNew: false };

  // The burst starts at its first counted act, so "34 contacts in 52 minutes" is true.
  const id = newId();
  await db.execute(sql`
    INSERT INTO security_alerts (id, user_id, rule, observed, threshold, window_start, window_end, action)
    SELECT ${id}, ${a.userId}, ${a.rule}, ${a.observed}, ${a.threshold},
           coalesce((SELECT min(at) FROM audit_log
                      WHERE actor_user_id = ${a.userId} AND action = ${RULES[a.rule].audit} AND at > w.since), w.since),
           now(), ${a.action}
      FROM (SELECT ${since} AS since) w`);
  await lumeAudit(db, {
    action: "security.alert",
    entityType: "security_alert",
    entityId: id,
    diff: { userId: a.userId, rule: a.rule, observed: a.observed, threshold: a.threshold },
  });
  return { id, isNew: true };
}
