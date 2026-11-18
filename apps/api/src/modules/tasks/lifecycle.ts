import { and, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { readSignal } from "../notifications/hub";
import { schema } from "@lume/db";
import { cancelReminders } from "./engine";

const T = schema.tasks;

/** The lead's next open follow-up, for lists that sort and filter by it (Phase 3 spec §3). */
export async function refreshNextDue(req: FastifyRequest, leadId: string) {
  await req.db.execute(
    sql`UPDATE leads SET next_task_due_at = (SELECT min(due_at) FROM tasks WHERE lead_id = ${leadId} AND status = 'open') WHERE id = ${leadId}`,
  );
}

/**
 * Once this request commits, the follow-up's reminders stop waiting to be read: it was done, cancelled or
 * moved, so a reminder of it has nothing left to say (3B final review, Important 2). As its assignee, since
 * notifications are only ever their own — whoever did it.
 */
/**
 * Other people's notices of these follow-ups (a manager's escalation, "you were given it" for whoever it isn't with
 * now), settled in this transaction through 0114's gate, and each of those bells told when it commits. In the
 * transaction, so a job (LUME AI, a stage rule) settles them as a request does, with no connection of its own
 * (review 2026-11-18).
 */
export async function settleTaskNotices(req: FastifyRequest, ids: string[]) {
  if (!ids.length) return;
  const { rows } = await req.db.execute<{ u: string }>(
    sql`SELECT DISTINCT s.u FROM unnest(${`{${ids.join(",")}}`}::uuid[]) AS x(id)
         CROSS JOIN LATERAL lume_settle_task_notices(x.id) AS s(u)`,
  );
  for (const r of rows) await req.db.execute(sql`SELECT pg_notify('lume_notifications', ${readSignal(r.u)})`);
}

export async function settleReminders(req: FastifyRequest, t: { id: string; assigneeId: string }) {
  await settleRemindersMany(req, [t]);
}

/**
 * The same for many follow-ups closed together (a lead removed, someone offboarded): everyone's notices in one go, and
 * each assignee's own reminders once per person, not once per follow-up (review 2026-11-18).
 */
export async function settleRemindersMany(req: FastifyRequest, tasks: { id: string; assigneeId: string }[]) {
  if (!tasks.length) return;
  await settleTaskNotices(
    req,
    tasks.map((t) => t.id),
  );
  const byPerson = new Map<string, string[]>();
  for (const t of tasks) byPerson.set(t.assigneeId, [...(byPerson.get(t.assigneeId) ?? []), t.id]);
  for (const [userId, ids] of byPerson) {
    // Your own: in this transaction, so whatever you look at next already has them read.
    if (req.actor?.userId === userId) {
      await req.db.execute(
        sql`UPDATE notifications SET read_at = now()
             WHERE task_id = ANY(${`{${ids.join(",")}}`}::uuid[]) AND read_at IS NULL
               AND kind IN ('follow_up_due', 'follow_up_soon', 'follow_up_nudge')`,
      );
      await req.db.execute(sql`SELECT pg_notify('lume_notifications', ${readSignal(userId)})`);
      continue;
    }
    // Someone else's: theirs to read as them, once this commits.
    req.afterCommit(() => {
      req.server
        .settleReminders?.(userId, ids)
        .catch((err: unknown) => req.log.error({ err }, "couldn't mark a follow-up's reminders read"));
    });
  }
}

/**
 * The same for work outside a request (the calendar sweep), in its own transaction: each follow-up's reminders read
 * as its assignee (notifications are only ever their own), the one acting put back after (bug hunt 2026-11-17).
 */
export async function settleRemindersIn(
  c: { query: (q: string, v?: unknown[]) => Promise<{ rows: { s?: string | null }[] }> },
  closed: { id: string; assignee_id: string }[],
) {
  if (!closed.length) return;
  const was = (await c.query("SELECT current_setting('lume.user_id', true) AS s")).rows[0]?.s ?? "";
  const byPerson = new Map<string, string[]>();
  for (const t of closed) byPerson.set(t.assignee_id, [...(byPerson.get(t.assignee_id) ?? []), t.id]);
  // Escalations and "you were given it" (0114), whoever's they are.
  const told = new Set<string>();
  for (const t of closed)
    for (const r of (await c.query("SELECT u AS s FROM lume_settle_task_notices($1) u", [t.id])).rows)
      if (r.s) told.add(r.s);
  for (const u of told)
    if (!byPerson.has(u)) await c.query("SELECT pg_notify('lume_notifications', $1)", [readSignal(u)]);
  for (const [userId, ids] of byPerson) {
    await c.query("SELECT set_config('lume.user_id', $1, true)", [userId]);
    await c.query(
      `UPDATE notifications SET read_at = now()
        WHERE task_id = ANY($1::uuid[]) AND read_at IS NULL AND kind IN ('follow_up_due', 'follow_up_soon', 'follow_up_nudge')`,
      [ids],
    );
    await c.query("SELECT pg_notify('lume_notifications', $1)", [readSignal(userId)]);
  }
  await c.query("SELECT set_config('lume.user_id', $1, true)", [was]);
}

/** A lead removed: its open follow-ups are cancelled, and their reminders with them (spec §3). */
export async function cancelLeadTasks(req: FastifyRequest, leadId: string): Promise<number> {
  const open = await req.db
    .update(T)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(T.leadId, leadId), eq(T.status, "open")))
    .returning({ id: T.id, assigneeId: T.assigneeId });
  for (const t of open) await cancelReminders(req.db, t.id);
  await settleRemindersMany(req, open);
  await refreshNextDue(req, leadId);
  return open.length;
}
