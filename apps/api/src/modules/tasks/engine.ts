import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { reminderTimes } from "@lume/core";
import { schema } from "@lume/db";
import { applyRequestScope } from "../../db/context";
import { loadActor } from "../../rbac/actor";
import { wants } from "../notifications/notify";

const SN = schema.scheduledNotifications;
type Db = NodePgDatabase<typeof schema>;
export type EngineDeps = { app: FastifyInstance; pool: pg.Pool };
/** A reminder this close behind its time still fires (the sweeper's margin; spec §3 Accuracy). */
const GRACE_MS = 30_000;

/** "15 min", "1 hour", "2 days": how far ahead a reminder is. */
export function inWords(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440 && minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  const days = Math.round(minutes / 1440);
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * A follow-up's reminders, afresh (spec §5): one pending row per offset still ahead (or within the grace),
 * reusing each offset's row so a reminder that already fired fires again for the new time. Offsets it no
 * longer has are cancelled. Returns the pending ids, for the queue once this transaction commits.
 */
export async function schedule(
  db: Db,
  task: { id: string; dueAt: Date; remindMinutes: number[]; status: string },
  now: Date,
): Promise<number[]> {
  if (task.status !== "open") {
    await cancelReminders(db, task.id);
    return [];
  }
  const wanted = reminderTimes(task.dueAt, task.remindMinutes).filter(
    (r) => r.at.getTime() >= now.getTime() - GRACE_MS,
  );
  await db
    .update(SN)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(SN.taskId, task.id),
        eq(SN.status, "pending"),
        wanted.length
          ? notInArray(
              SN.offsetMinutes,
              wanted.map((w) => w.offset),
            )
          : sql`true`,
      ),
    );
  // Only a reminder whose time changed (or that was cancelled) is armed again: an edit to the words alone
  // never re-sends one that already fired (3A final review, Critical 1 and Minor 7).
  for (const w of wanted)
    await db.execute(sql`
      INSERT INTO scheduled_notifications (task_id, offset_minutes, fire_at, status)
      VALUES (${task.id}, ${w.offset}, ${w.at}, 'pending')
      ON CONFLICT (task_id, offset_minutes) DO UPDATE
        SET fire_at = EXCLUDED.fire_at, status = 'pending', fired_at = NULL
        WHERE scheduled_notifications.fire_at IS DISTINCT FROM EXCLUDED.fire_at
           OR scheduled_notifications.status = 'cancelled'`);
  const pending = await db
    .select({ id: SN.id })
    .from(SN)
    .where(and(eq(SN.taskId, task.id), eq(SN.status, "pending")));
  return pending.map((r) => r.id);
}

export async function cancelReminders(db: Db, taskId: string): Promise<void> {
  await db
    .update(SN)
    .set({ status: "cancelled" })
    .where(and(eq(SN.taskId, taskId), eq(SN.status, "pending")));
}

/**
 * One reminder (spec §3 Firing). The row is locked, skipping one another fire holds, and re-checked, so
 * the job and the sweeper together write one notification. It's written as the assignee, under their own
 * lead scope: a lead they can no longer see is never named (Review Focus 4).
 */
export async function fire(o: EngineDeps, id: number, now: Date = new Date()): Promise<"fired" | "skipped"> {
  const client = await o.pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ task_id: string; offset_minutes: number }>(
      `SELECT task_id, offset_minutes FROM scheduled_notifications
        WHERE id = $1 AND status = 'pending' AND fire_at <= $2::timestamptz + interval '2 seconds'
        FOR UPDATE SKIP LOCKED`,
      // A job queued for a time the reminder has since moved from finds it not yet due, and leaves it for
      // the job queued for its new time (3A final review, Critical 1).
      [id, now],
    );
    const sn = rows[0];
    if (!sn) {
      await client.query("ROLLBACK");
      return "skipped";
    }
    // Reading the follow-up itself is LUME's own business (it names no one to anybody): every lead.
    await client.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const task = (
      await client.query<{
        status: string;
        assignee_id: string;
        lead_id: string;
        title: string;
        due_at: Date;
      }>("SELECT status, assignee_id, lead_id, title, due_at FROM tasks WHERE id = $1", [sn.task_id])
    ).rows[0];
    let notified: number | null = null;
    // On this connection: waiting on the pool it already holds one of could wait for ever (Minor 1).
    const actor = task?.status === "open" ? await loadActor(client, task.assignee_id) : null;
    // The person may have switched due reminders off (3B): it still counts as fired, and stays on Today.
    const prefs =
      task && actor
        ? (
            await client.query<{ preferences: unknown }>("SELECT preferences FROM users WHERE id = $1", [
              task.assignee_id,
            ])
          ).rows[0]
        : undefined;
    const kind = sn.offset_minutes === 0 ? "follow_up_due" : "follow_up_soon";
    if (task && actor && wants(prefs?.preferences, kind)) {
      await applyRequestScope(client, actor);
      const lead = (
        await client.query<{ name: string }>("SELECT name FROM leads WHERE id = $1 AND deleted_at IS NULL", [
          task.lead_id,
        ])
      ).rows[0];
      if (lead) {
        const due = sn.offset_minutes === 0;
        const ins = await client.query<{ id: string }>(
          `INSERT INTO notifications (user_id, kind, task_id, lead_id, title, body, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            task.assignee_id,
            due ? "follow_up_due" : "follow_up_soon",
            sn.task_id,
            task.lead_id,
            `${task.title} — ${lead.name}`,
            due ? "Now" : `In ${inWords(sn.offset_minutes)}`,
            { dueAt: task.due_at },
          ],
        );
        notified = Number(ins.rows[0]!.id);
        await client.query("SELECT pg_notify('lume_notifications', $1)", [
          JSON.stringify({ u: task.assignee_id, n: notified }),
        ]);
      }
    }
    await client.query(
      "UPDATE scheduled_notifications SET status = 'fired', fired_at = now() WHERE id = $1",
      [id],
    );
    await client.query("COMMIT");
    return notified ? "fired" : "skipped";
  } catch (e) {
    broken = await client.query("ROLLBACK").then(
      () => false,
      () => true,
    );
    throw e;
  } finally {
    client.release(broken || undefined);
  }
}

/**
 * Every reminder more than 30 s past its time and still pending is fired now (spec §3 The sweeper): a
 * lost job, a restart or a clock step never loses one. A row another fire holds is skipped, not waited on.
 */
export async function sweep(o: EngineDeps, now: Date = new Date()): Promise<number> {
  const { rows } = await o.pool.query<{ id: string }>(
    `SELECT id FROM scheduled_notifications
      WHERE status = 'pending' AND fire_at < $1::timestamptz - interval '30 seconds'
      ORDER BY fire_at LIMIT 500`,
    [now],
  );
  let fired = 0;
  for (const r of rows) if ((await fire(o, Number(r.id), now)) === "fired") fired++;
  return fired;
}

/** The pending reminders of these follow-ups, with their times (for the queue after a write commits). */
export async function pendingOf(db: Db, taskIds: string[]) {
  if (!taskIds.length) return [];
  return db
    .select({ id: SN.id, fireAt: SN.fireAt })
    .from(SN)
    .where(and(inArray(SN.taskId, taskIds), eq(SN.status, "pending")));
}
