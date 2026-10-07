import { drizzle } from "drizzle-orm/node-postgres";
import { newId, NO_TOUCH_RULE_ID, plural, shiftToWorkingHours } from "@lume/core";
import { schema } from "@lume/db";
import { followUpsFrom, workingHoursFrom } from "../settings/follow-ups";
import { schedule, type EngineDeps } from "./engine";

const BATCH = 500;

/**
 * Leads gone quiet (3C Task 4; report §10.5 "No-touch alert"): a lead in an open stage that nobody has
 * touched for Settings → Follow-ups' days comes back to its owner as a follow-up, inside working hours.
 * Never for a lead with any open follow-up, and once per quiet window. 500 a run, oldest first; a second
 * process running at the same moment steps aside (Review Focus 5). Returns how many it set.
 */
export async function noTouch(
  o: EngineDeps & { enqueue?: (r: { id: number; fireAt: Date }[]) => Promise<void> },
  now: Date = new Date(),
): Promise<number> {
  const client = await o.pool.connect();
  const armed: number[] = [];
  let created = 0;
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('lume.no_touch')) AS ok",
    );
    if (!lock.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return 0;
    }
    const { rows: s } = await client.query<{ f: unknown; wh: unknown; tz: string }>(
      "SELECT follow_ups AS f, working_hours AS wh, timezone AS tz FROM settings WHERE id = 1",
    );
    const { noTouch: rule, shiftToWorkingHours: shift } = followUpsFrom(s[0]?.f);
    if (!rule.enabled) {
      await client.query("ROLLBACK");
      return 0;
    }
    // LUME's own look across every lead; it names nobody to anybody but the lead's owner.
    await client.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const { rows: quiet } = await client.query<{ id: string; owner_id: string }>(
      `SELECT l.id, l.owner_id FROM leads l
         JOIN stages st ON st.id = l.stage_id
         JOIN users u ON u.id = l.owner_id
        WHERE st.kind = 'open' AND l.deleted_at IS NULL AND u.status = 'active'
          AND coalesce(l.last_activity_at, l.created_at) < $1::timestamptz - make_interval(days => $2)
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.status = 'open')
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.auto_rule_id = $3
                            AND t.created_at > $1::timestamptz - make_interval(days => $2))
          -- Only leads that went quiet after it was switched on (Settings keeps when: noTouch.from).
          AND ($5::timestamptz IS NULL
               OR coalesce(l.last_activity_at, l.created_at) + make_interval(days => $2) >= $5::timestamptz)
        ORDER BY coalesce(l.last_activity_at, l.created_at)
        LIMIT $4`,
      [now, rule.days, NO_TOUCH_RULE_ID, BATCH, rule.from ?? null],
    );
    const db = drizzle(client, { schema });
    const due = shift ? shiftToWorkingHours(now, workingHoursFrom(s[0]?.wh), s[0]?.tz ?? "UTC") : now;
    const title = `No contact for ${plural(rule.days, "day")}`;
    for (const l of quiet) {
      // Written on its owner's behalf (a lead's row asks for a person); its history still says LUME.
      await client.query("SELECT set_config('lume.user_id', $1, true)", [l.owner_id]);
      const id = newId();
      const [t] = await db
        .insert(schema.tasks)
        .values({
          id,
          leadId: l.id,
          assigneeId: l.owner_id,
          title,
          dueAt: due,
          remindMinutes: [0],
          seriesId: id,
          autoRuleId: NO_TOUCH_RULE_ID,
        })
        .returning();
      armed.push(...(await schedule(db, t!, now)));
      await client.query(
        "UPDATE leads SET next_task_due_at = (SELECT min(due_at) FROM tasks WHERE lead_id = $1 AND status = 'open') WHERE id = $1",
        [l.id],
      );
      await client.query(
        "INSERT INTO activities (id, lead_id, user_id, type, payload) VALUES ($1, $2, NULL, 'automation', $3)",
        [newId(), l.id, { rule: "no_touch", result: "done", days: rule.days, taskId: id }],
      );
      created++;
    }
    if (created)
      await client.query("INSERT INTO ops_events (kind, ok, detail) VALUES ('tasks.no_touch', true, $1)", [
        { created },
      ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    await o.pool
      .query("INSERT INTO ops_events (kind, ok, detail) VALUES ('tasks.no_touch', false, $1)", [
        // Its code only: a database message can quote a row, and ops events hold kinds and ids alone.
        { code: String((err as { code?: unknown }).code ?? "failed") },
      ])
      .catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  if (armed.length && o.enqueue) {
    const { rows } = await o.pool.query<{ id: string; fire_at: Date }>(
      "SELECT id, fire_at FROM scheduled_notifications WHERE id = ANY($1::bigint[]) AND status = 'pending'",
      [armed],
    );
    await o
      .enqueue(rows.map((r) => ({ id: Number(r.id), fireAt: r.fire_at })))
      .catch((err: unknown) =>
        o.app.log.error({ err }, "couldn't queue quiet leads' reminders; the sweeper will"),
      );
  }
  return created;
}
