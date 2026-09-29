import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  dueFromPreset,
  dueFromPresetDef,
  leadScope,
  localDayBounds,
  newId,
  nextOccurrence,
  scopeOf,
  snoozeUntil,
  type Actor,
  type Recurrence,
  type SnoozePreset,
} from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden, notFound } from "../../http/errors";
import { loadActor } from "../../rbac/actor";
import { recordActivity } from "../leads/writer";
import { visibleLead } from "../leads/service";
import { cancelReminders, pendingOf, schedule } from "./engine";
import { refreshNextDue, settleReminders } from "./lifecycle";
import { readFollowUps } from "../settings/follow-ups";

const T = schema.tasks;
const L = schema.leads;
type Task = typeof T.$inferSelect;
export type Due = { at: string } | { preset: string };
export type TaskInput = {
  title?: string;
  note?: string | null;
  due?: Due;
  remindMinutes?: number[];
  recurrence?: Recurrence | null;
  assigneeId?: string;
};

// ——— Who may do what (Phase 3 spec §3) ———

/** Yourself always; others by tasks.manage_others: `all` anyone, `team` your teams' members, `own` nobody. */
export function mayManageFor(actor: Actor, userId: string): boolean {
  if (userId === actor.userId) return true;
  const s = scopeOf(actor, "tasks.manage_others");
  return s === "all" || (s === "team" && actor.teamMemberIds.includes(userId));
}

/** Whether a person could see a lead with this owner: `lume_can_see_owner`, for someone else. */
async function assigneeCanSee(d: AppDeps, userId: string, ownerId: string | null): Promise<boolean> {
  const a = await loadActor(d.pool, userId);
  if (!a) return false;
  const s = leadScope(a);
  if (s === "all") return true;
  if (!ownerId) return false;
  return ownerId === userId || (s === "team" && a.teamMemberIds.includes(ownerId));
}

/** The caller's own timezone, else the business's (spec §3 Times). */
export async function timezoneOf(req: FastifyRequest, userId: string): Promise<string> {
  const { rows } = await req.db.execute<{ tz: string }>(
    sql`SELECT coalesce(u.timezone, s.timezone) AS tz FROM settings s LEFT JOIN users u ON u.id = ${userId} WHERE s.id = 1`,
  );
  return rows[0]?.tz ?? "UTC";
}

/** A due time: as given, or from one of the time choices Settings → Follow-ups has right now (3C). */
async function resolveDue(req: FastifyRequest, due: Due, tz: string, now: Date): Promise<Date> {
  if ("at" in due) return new Date(due.at);
  const def = (await readFollowUps(req)).duePresets.find((p) => p.id === due.preset);
  if (!def) throw badRequest("UNKNOWN_PRESET", "That time choice was just changed. Pick another.");
  return dueFromPresetDef(def, now, tz);
}

// ——— Keeping everything around a follow-up true ———

/** Once this request commits, each pending reminder of these follow-ups goes to the queue for its time. */
async function queueReminders(req: FastifyRequest, d: AppDeps, taskIds: string[]) {
  const pending = await pendingOf(req.db, taskIds);
  // Never an unhandled rejection (it would take the API down): a queue that's down leaves the reminders
  // pending, and the sweeper fires them on time (3A final review, Minor 3).
  if (pending.length)
    req.afterCommit(
      () =>
        void d.tasks
          ?.enqueue(pending)
          .catch((err: unknown) =>
            req.log.error({ err }, "couldn't queue follow-up reminders; the sweeper will"),
          ),
    );
}

// ——— What the screens see ———

export type TaskView = Awaited<ReturnType<typeof views>>[number];

async function views(req: FastifyRequest, rows: Task[]) {
  if (!rows.length) return [];
  const userIds = [...new Set(rows.flatMap((t) => [t.assigneeId, t.createdBy].filter(Boolean) as string[]))];
  const leadIds = [...new Set(rows.map((t) => t.leadId))];
  const people = await req.db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.id, userIds));
  const leads = await req.db.select({ id: L.id, name: L.name }).from(L).where(inArray(L.id, leadIds));
  const who = new Map(people.map((p) => [p.id, p]));
  const leadName = new Map(leads.map((l) => [l.id, l.name]));
  return rows.map((t) => ({
    id: t.id,
    leadId: t.leadId,
    leadName: leadName.get(t.leadId) ?? "",
    title: t.title,
    note: t.note,
    dueAt: t.dueAt.toISOString(),
    status: t.status,
    remindMinutes: t.remindMinutes,
    recurrence: t.recurrence ?? null,
    assignee: who.get(t.assigneeId) ?? { id: t.assigneeId, name: "" },
    createdBy: t.createdBy ? (who.get(t.createdBy) ?? null) : null,
    doneAt: t.doneAt?.toISOString() ?? null,
    canEdit: t.status === "open" && mayManageFor(req.actor!, t.assigneeId),
  }));
}
export const viewOf = async (req: FastifyRequest, t: Task) => (await views(req, [t]))[0]!;
export const viewsOf = views;

export async function leadTasks(req: FastifyRequest, leadId: string) {
  await visibleLead(req, leadId);
  const open = await req.db
    .select()
    .from(T)
    .where(and(eq(T.leadId, leadId), eq(T.status, "open")))
    .orderBy(asc(T.dueAt));
  const closed = await req.db
    .select()
    .from(T)
    .where(and(eq(T.leadId, leadId), sql`${T.status} <> 'open'`))
    .orderBy(desc(T.updatedAt))
    .limit(10);
  return { items: await views(req, [...open, ...closed]) };
}

// ——— Writing ———

async function checkAssignee(req: FastifyRequest, d: AppDeps, assigneeId: string, ownerId: string | null) {
  if (!mayManageFor(req.actor!, assigneeId))
    throw forbidden("CANNOT_ASSIGN_TASK", "Giving follow-ups to someone else isn't part of your role.");
  if (assigneeId !== req.actor!.userId && !(await assigneeCanSee(d, assigneeId, ownerId)))
    throw new HttpError(
      409,
      "ASSIGNEE_CANT_SEE_LEAD",
      "That person can't see this lead, so they can't follow it up.",
    );
}

const auditForOther = (
  req: FastifyRequest,
  t: { id: string; assigneeId: string; title: string },
  what: string,
) =>
  t.assigneeId === req.actor!.userId
    ? Promise.resolve()
    : audit(req, {
        action: "task.changed_for_other",
        entityType: "task",
        entityId: t.id,
        diff: { what, title: t.title, assigneeId: t.assigneeId },
      });

export async function createTask(req: FastifyRequest, d: AppDeps, leadId: string, body: TaskInput) {
  const lead = await visibleLead(req, leadId);
  const actor = req.actor!;
  const assigneeId = body.assigneeId ?? actor.userId;
  await checkAssignee(req, d, assigneeId, lead.ownerId);
  const now = new Date();
  // No time given: tomorrow at 10:00, whatever the choices are (3A's default).
  const tz = await timezoneOf(req, actor.userId);
  const dueAt = body.due ? await resolveDue(req, body.due, tz, now) : dueFromPreset("tomorrow_10", now, tz);
  const id = newId();
  const [t] = await req.db
    .insert(T)
    .values({
      id,
      leadId,
      assigneeId,
      title: body.title?.trim() || "Follow up",
      note: body.note ?? null,
      dueAt,
      remindMinutes: body.remindMinutes ?? [0],
      recurrence: body.recurrence ?? null,
      seriesId: id,
      createdBy: actor.userId,
    })
    .returning();
  await schedule(req.db, t!, now);
  await refreshNextDue(req, leadId);
  await recordActivity(req, leadId, "follow_up_set", {
    taskId: id,
    title: t!.title,
    dueAt: dueAt.toISOString(),
    assigneeId,
  });
  await auditForOther(req, t!, "set");
  await queueReminders(req, d, [id]);
  tellAssignee(req, t!, lead.name);
  return viewOf(req, t!);
}

/** "Remind them" (3B, from an escalation): the assignee hears that someone who manages them is asking. */
export async function nudgeTask(req: FastifyRequest, id: string) {
  const t = await openForChange(req, id);
  if (t.assigneeId === req.actor!.userId)
    throw badRequest("OWN_FOLLOW_UP", "This follow-up is yours: there's no one to remind.");
  const lead = await visibleLead(req, t.leadId);
  const by = req.actor!.userId;
  req.afterCommit(
    () =>
      void (async () => {
        const who = (await req.server.notifyNameOf?.(by)) ?? "Someone";
        await req.server.notify?.(t.assigneeId, {
          kind: "follow_up_nudge",
          title: `${who} asks about your follow-up with ${lead.name}`,
          body: t.title,
          leadId: t.leadId,
          taskId: t.id,
        });
      })().catch((err: unknown) => req.log.error({ err }, "couldn't send a reminder")),
  );
  await auditForOther(req, t, "reminded");
}

/** Someone else gave this person a follow-up: they hear, by the lead's name, once it's saved (3B). */
function tellAssignee(req: FastifyRequest, t: Task, leadName: string) {
  if (t.assigneeId === req.actor!.userId || !req.server.notify) return;
  const by = req.actor!.userId;
  req.afterCommit(
    () =>
      void (async () => {
        const who = (await req.server.notifyNameOf?.(by)) ?? "Someone";
        await req.server.notify!(t.assigneeId, {
          kind: "follow_up_assigned",
          title: `${who} gave you a follow-up — ${leadName}`,
          body: t.title,
          leadId: t.leadId,
          taskId: t.id,
        });
      })().catch((err: unknown) => req.log.error({ err }, "couldn't tell the assignee")),
  );
}

/** The follow-up, locked for this request, still open, and the caller's to change. */
async function openForChange(req: FastifyRequest, id: string): Promise<Task> {
  const { rows } = await req.db.execute<{ id: string }>(
    sql`SELECT id FROM tasks WHERE id = ${id} FOR UPDATE`,
  );
  if (!rows[0]) throw notFound("TASK_NOT_FOUND", "Follow-up not found");
  const [t] = await req.db.select().from(T).where(eq(T.id, id));
  if (t!.status !== "open")
    throw new HttpError(409, "NOT_OPEN", "This follow-up is already done or cancelled.");
  if (!mayManageFor(req.actor!, t!.assigneeId))
    throw forbidden(
      "CANNOT_CHANGE_TASK",
      "This follow-up is someone else's, and changing theirs isn't part of your role.",
    );
  return t!;
}

export async function updateTask(req: FastifyRequest, d: AppDeps, id: string, body: TaskInput) {
  const t = await openForChange(req, id);
  const now = new Date();
  const set: Partial<typeof T.$inferInsert> = { updatedAt: now, version: t.version + 1 };
  if (body.title !== undefined) set.title = body.title.trim() || "Follow up";
  if (body.note !== undefined) set.note = body.note;
  if (body.due) {
    set.dueAt = await resolveDue(req, body.due, await timezoneOf(req, req.actor!.userId), now);
    set.escalatedAt = null; // a new time: if it's left overdue again, its managers hear again (3B)
  }
  if (body.remindMinutes) set.remindMinutes = body.remindMinutes;
  if (body.recurrence !== undefined) set.recurrence = body.recurrence;
  if (body.assigneeId && body.assigneeId !== t.assigneeId) {
    const lead = await visibleLead(req, t.leadId);
    await checkAssignee(req, d, body.assigneeId, lead.ownerId);
    set.assigneeId = body.assigneeId;
    set.escalatedAt = null; // their managers hear if it's left overdue (3B final review)
  }
  const [u] = await req.db.update(T).set(set).where(eq(T.id, id)).returning();
  if (body.due || set.assigneeId) await settleReminders(req, t);
  if (set.assigneeId) tellAssignee(req, u!, (await visibleLead(req, t.leadId)).name);
  await schedule(req.db, u!, now);
  await refreshNextDue(req, t.leadId);
  await recordActivity(req, t.leadId, "follow_up_changed", {
    taskId: id,
    title: u!.title,
    dueAt: u!.dueAt.toISOString(),
  });
  await auditForOther(req, u!, "changed");
  await queueReminders(req, d, [id]);
  return viewOf(req, u!);
}

export async function snoozeTask(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  body: { until: string } | { preset: SnoozePreset },
) {
  const now = new Date();
  const until =
    "until" in body
      ? new Date(body.until)
      : snoozeUntil(body.preset, now, await timezoneOf(req, req.actor!.userId));
  return updateTask(req, d, id, { due: { at: until.toISOString() } });
}

export async function cancelTask(req: FastifyRequest, id: string) {
  const t = await openForChange(req, id);
  const now = new Date();
  const [u] = await req.db
    .update(T)
    .set({ status: "cancelled", cancelledAt: now, updatedAt: now, version: t.version + 1 })
    .where(eq(T.id, id))
    .returning();
  await cancelReminders(req.db, id);
  await settleReminders(req, t);
  await refreshNextDue(req, t.leadId);
  await recordActivity(req, t.leadId, "follow_up_cancelled", { taskId: id, title: t.title });
  await auditForOther(req, t, "cancelled");
  return viewOf(req, u!);
}

/** Whether a repeating follow-up has reached one of its stops (spec §3 Recurrence). */
async function stopped(req: FastifyRequest, t: Task, r: Recurrence): Promise<boolean> {
  const { rows } = await req.db.execute<{ kind: string; replied: boolean }>(sql`
    SELECT s.kind,
      EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.type = 'reply_logged'
        AND a.occurred_at >= (SELECT min(created_at) FROM tasks WHERE series_id = ${t.seriesId})) AS replied
    FROM leads l JOIN stages s ON s.id = l.stage_id WHERE l.id = ${t.leadId}`);
  const x = rows[0];
  if (!x) return true;
  return (
    (r.stopOn.includes("won") && x.kind === "won") ||
    (r.stopOn.includes("lost") && x.kind === "lost") ||
    (r.stopOn.includes("reply_logged") && x.replied)
  );
}

export async function doneTask(req: FastifyRequest, d: AppDeps, id: string) {
  const t = await openForChange(req, id);
  const actor = req.actor!;
  const now = new Date();
  const [u] = await req.db
    .update(T)
    .set({ status: "done", doneAt: now, doneBy: actor.userId, updatedAt: now, version: t.version + 1 })
    .where(eq(T.id, id))
    .returning();
  await cancelReminders(req.db, id);
  await settleReminders(req, t);
  await recordActivity(req, t.leadId, "follow_up_done", { taskId: id, title: t.title });
  // A follow-up done is contact: the lead isn't gone quiet (3C final review, Important 3).
  await req.db.update(L).set({ lastActivityAt: now }).where(eq(L.id, t.leadId));
  await auditForOther(req, t, "done");

  // A repeat: the next one, in the same series, unless it has reached a stop (spec §3 Recurrence).
  let next: Task | null = null;
  const tz = await timezoneOf(req, t.assigneeId);
  if (t.recurrence && !(await stopped(req, t, t.recurrence))) {
    const due = nextOccurrence(t.dueAt, t.recurrence, now, tz);
    if (due) {
      const nid = newId();
      [next] = (await req.db
        .insert(T)
        .values({
          id: nid,
          leadId: t.leadId,
          assigneeId: t.assigneeId,
          title: t.title,
          note: t.note,
          dueAt: due,
          remindMinutes: t.remindMinutes,
          recurrence: t.recurrence,
          seriesId: t.seriesId,
          createdBy: actor.userId,
        })
        .returning()) as [Task];
      await schedule(req.db, next, now);
      await recordActivity(req, t.leadId, "follow_up_set", {
        taskId: nid,
        title: t.title,
        dueAt: due.toISOString(),
        repeat: true,
      });
      await queueReminders(req, d, [nid]);
    }
  }
  await refreshNextDue(req, t.leadId);

  // The caller's day is clear when nothing of theirs is still open before it ends (the `cleared` sound).
  const { end } = localDayBounds(now, await timezoneOf(req, actor.userId));
  const { rows } = await req.db.execute<{ left: number }>(
    sql`SELECT count(*)::int AS left FROM tasks WHERE assignee_id = ${actor.userId} AND status = 'open' AND due_at < ${end}`,
  );
  return {
    task: await viewOf(req, u!),
    next: next ? await viewOf(req, next) : null,
    clearedToday: t.assigneeId === actor.userId && t.dueAt < end && rows[0]!.left === 0,
  };
}
