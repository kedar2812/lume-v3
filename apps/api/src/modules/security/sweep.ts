import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { RULES, RULE_IDS, breached, isWatched, mergeAnomaly } from "@lume/core";
import { schema, type SecuritySettings } from "@lume/db";
import { loadActor } from "../../rbac/actor";
import { raiseAlert } from "./alerts";
import { windowStart } from "./counts";
import { suspendUser, tellAdmins } from "./suspend";

/**
 * Every 5 minutes (spec §2.3): the safety net under the inline check. For each rule that's on, one grouped
 * count over the audit index finds anyone past its line — acts the inline check never saw (a request that
 * failed after its audit row, an act no route watches). Each breach raises or grows its alert, and pauses
 * for a pause rule, in its own transaction; admins hear only of a new alert. Returns how many were new.
 */
export async function securitySweep(o: { pool: pg.Pool; clock: () => Date }): Promise<number> {
  const { rows: s } = await o.pool.query<{ timezone: string; security: SecuritySettings }>(
    "SELECT timezone, security FROM settings WHERE id = 1",
  );
  if (!s[0]) return 0;
  const tz = s[0].timezone;
  const rules = mergeAnomaly(s[0].security?.anomaly);
  const fresh: string[] = [];
  for (const rule of RULE_IDS) {
    const setting = rules[rule];
    if (setting.action === "off") continue;
    const def = RULES[rule];
    const counted = def.distinct ? sql`count(DISTINCT a.entity_id)` : sql`count(*)`;
    const db = drizzle(o.pool, { schema });
    const { rows } = await db.execute(sql`
      SELECT a.actor_user_id AS id, ${counted}::int AS observed
        FROM audit_log a JOIN users u ON u.id = a.actor_user_id
       WHERE a.action = ${def.audit} AND u.status = 'active' AND NOT u.is_owner
         AND a.at > now() - interval '1 day'
         AND a.at > ${windowStart(rule, tz, sql`a.actor_user_id`)}
       GROUP BY a.actor_user_id
      HAVING ${counted} > ${setting.threshold}`);
    for (const r of rows as { id: string; observed: number }[]) {
      const actor = await loadActor(o.pool, r.id);
      if (!actor || !isWatched(actor) || !breached(r.observed, setting.threshold)) continue;
      const client = await o.pool.connect();
      try {
        await client.query("BEGIN");
        const tx = drizzle(client, { schema });
        const pauses = setting.action === "suspend";
        const alert = await raiseAlert(tx, {
          userId: r.id,
          rule,
          observed: r.observed,
          threshold: setting.threshold,
          action: pauses ? "suspended" : "alerted",
          tz,
        });
        if (pauses) await suspendUser(tx, r.id, o.clock(), alert.id);
        await client.query("COMMIT");
        if (alert.isNew) fresh.push(alert.id);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    }
  }
  for (const id of fresh) await tellAdmins(o.pool, id);
  return fresh.length;
}
