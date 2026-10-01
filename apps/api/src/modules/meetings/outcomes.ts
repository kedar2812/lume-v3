import { drizzle } from "drizzle-orm/node-postgres";
import { LOG_OUTCOME_RULE_ID, newId } from "@lume/core";
import { schema } from "@lume/db";
import { schedule, type EngineDeps } from "../tasks/engine";

const BATCH = 200;
/** Only meetings that ended in the last day are asked about: a first connect never floods anyone. */
const ASK_WITHIN_MS = 24 * 3_600_000;

/**
 * Log outcome (spec §2.5): after a meeting with a lead ends, its owner gets one follow-up to say how it went.
 * Unlinked meetings aren't asked about (a follow-up needs a lead). A second process at the same moment steps
 * aside. Returns how many it set.
 */
export async function askOutcomes(
  o: EngineDeps & { enqueue?: (r: { id: number; fireAt: Date }[]) => Promise<void> },
  now: Date = new Date(),
): Promise<number> {
  const client = await o.pool.connect();
  const armed: number[] = [];
  let created = 0;
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('lume.log_outcome')) AS ok",
    );
    if (!lock.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return 0;
    }
    // LUME's own look across every meeting (read-only); each follow-up is then written as its owner.
    await client.query(
      "SELECT set_config('lume.lead_scope', 'all', true), set_config('lume.calendar_sweep', 'on', true)",
    );
    const { rows: ended } = await client.query<{
      id: string;
      lead_id: string;
      owner_id: string;
      title: string;
    }>(
      `SELECT m.id, m.lead_id, m.owner_id, m.title FROM meetings m
         JOIN users u ON u.id = m.owner_id
         JOIN leads l ON l.id = m.lead_id
        WHERE m.status = 'scheduled' AND m.outcome_asked_at IS NULL AND m.lead_id IS NOT NULL
          AND m.ends_at <= $1 AND m.ends_at > $2 AND u.status = 'active' AND l.deleted_at IS NULL
        ORDER BY m.ends_at
        LIMIT $3`,
      [now, new Date(now.getTime() - ASK_WITHIN_MS), BATCH],
    );
    await client.query("SELECT set_config('lume.calendar_sweep', '', true)");
    const db = drizzle(client, { schema });
    for (const m of ended) {
      await client.query("SELECT set_config('lume.user_id', $1, true)", [m.owner_id]);
      const id = newId();
      const [t] = await db
        .insert(schema.tasks)
        .values({
          id,
          leadId: m.lead_id,
          assigneeId: m.owner_id,
          title: `Log outcome: ${m.title}`.slice(0, 200),
          dueAt: now,
          remindMinutes: [0],
          seriesId: id,
          autoRuleId: LOG_OUTCOME_RULE_ID,
        })
        .returning();
      armed.push(...(await schedule(db, t!, now)));
      await client.query("UPDATE meetings SET outcome_asked_at = $2, outcome_task_id = $3 WHERE id = $1", [
        m.id,
        now,
        id,
      ]);
      await client.query(
        "UPDATE leads SET next_task_due_at = (SELECT min(due_at) FROM tasks WHERE lead_id = $1 AND status = 'open') WHERE id = $1",
        [m.lead_id],
      );
      created++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
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
        o.app.log.error({ err }, "couldn't queue Log outcome reminders; the sweeper will"),
      );
  }
  return created;
}
