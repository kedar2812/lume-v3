import type { FastifyRequest } from "fastify";
import { sql, type SQL } from "drizzle-orm";
import { canOnRecord, scopeOf } from "@lume/core";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden, notFound } from "../../http/errors";
import { cancelReminders } from "../tasks/engine";
import { refreshNextDue } from "../tasks/lifecycle";

const DAY = 86_400_000;
/** The widest range the Calendar asks for at once (an agenda of a few months). */
const MAX_RANGE_MS = 100 * DAY;

export type MeetingView = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: string;
  link: string | null;
  location: string | null;
  ownerId: string;
  matchedBy: string;
  outcomeNote: string | null;
  lead: { id: string; name: string; pipelineId: string; stageId: string } | null;
};
type Row = {
  id: string;
  title: string;
  starts_at: Date | string;
  ends_at: Date | string;
  status: string;
  link: string | null;
  location: string | null;
  owner_id: string;
  matched_by: string;
  outcome_note: string | null;
  lead_id: string | null;
  lead_name: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
};
const view = (r: Row): MeetingView => ({
  id: r.id,
  title: r.title,
  startsAt: new Date(r.starts_at).toISOString(),
  endsAt: new Date(r.ends_at).toISOString(),
  status: r.status,
  link: r.link,
  location: r.location,
  ownerId: r.owner_id,
  matchedBy: r.matched_by,
  outcomeNote: r.outcome_note,
  lead: r.lead_id
    ? { id: r.lead_id, name: r.lead_name ?? "", pipelineId: r.pipeline_id!, stageId: r.stage_id! }
    : null,
});

/** Meetings as row-level security lets this person see them: linked ones by their lead; unlinked, their own. */
const SELECT = sql`SELECT m.id, m.title, m.starts_at, m.ends_at, m.status, m.link, m.location, m.owner_id,
    m.matched_by, m.outcome_note, m.lead_id, l.name AS lead_name, l.pipeline_id, l.stage_id
  FROM meetings m LEFT JOIN leads l ON l.id = m.lead_id
  WHERE (m.lead_id IS NULL OR l.deleted_at IS NULL)`;

async function rows(req: FastifyRequest, where: SQL): Promise<MeetingView[]> {
  const r = await req.db.execute<Row>(sql`${SELECT} AND ${where} ORDER BY m.starts_at, m.id`);
  return r.rows.map(view);
}

/**
 * The Calendar (spec §2.5): calendar.view's scope says whose meetings (own, their team's, everyone's);
 * row-level security still shows a linked meeting only with a lead they may see.
 */
export async function listMeetings(
  req: FastifyRequest,
  q: { from: Date; to: Date; ownerId?: string; pipelineId?: string; stageId?: string },
) {
  if (q.to <= q.from) throw badRequest("BAD_RANGE", "The range ends before it starts.");
  if (q.to.getTime() - q.from.getTime() > MAX_RANGE_MS)
    throw badRequest("BAD_RANGE", "Ask for 100 days or fewer at a time.");
  const a = req.actor!;
  const scope = a.isOwner ? "all" : scopeOf(a, "calendar.view");
  const owners = scope === "all" ? null : scope === "team" ? [a.userId, ...a.teamMemberIds] : [a.userId];
  const where: SQL[] = [sql`m.starts_at < ${q.to}`, sql`m.ends_at > ${q.from}`];
  if (owners) where.push(sql`m.owner_id IN ${owners}`);
  if (q.ownerId) where.push(sql`m.owner_id = ${q.ownerId}`);
  if (q.pipelineId) where.push(sql`l.pipeline_id = ${q.pipelineId}`);
  if (q.stageId) where.push(sql`l.stage_id = ${q.stageId}`);
  return { meetings: await rows(req, sql.join(where, sql` AND `)) };
}

/** A lead's meetings, whoever's calendar they're on (the drawer); the lead must be one they may see. */
export async function leadMeetings(req: FastifyRequest, leadId: string) {
  const lead = await req.db.execute<{ id: string }>(
    sql`SELECT id FROM leads WHERE id = ${leadId} AND deleted_at IS NULL`,
  );
  if (!lead.rows[0]) throw notFound("LEAD_NOT_FOUND", "LUME couldn't find this lead.");
  return { meetings: await rows(req, sql`m.lead_id = ${leadId}`) };
}

async function one(req: FastifyRequest, id: string): Promise<MeetingView> {
  const [m] = await rows(req, sql`m.id = ${id}`);
  if (!m) throw notFound("MEETING_NOT_FOUND", "LUME couldn't find this meeting.");
  return m;
}

/**
 * Attach an unlinked meeting to a lead, or record how it went (completed / no-show / rescheduled, once,
 * after it started). Its owner may, or anyone whose calendar.view covers its owner. Recording the outcome
 * completes the meeting's Log outcome follow-up.
 */
export async function patchMeeting(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  body: { leadId?: string; status?: "completed" | "no_show" | "rescheduled"; outcomeNote?: string | null },
) {
  const m = await one(req, id);
  const a = req.actor!;
  if (m.ownerId !== a.userId && !canOnRecord(a, "calendar.view", m.ownerId)) throw forbidden();
  if (body.leadId !== undefined) {
    if (m.lead) throw new HttpError(409, "MEETING_LINKED", "This meeting is already with a lead.");
    const lead = await req.db.execute<{ id: string }>(
      sql`SELECT id FROM leads WHERE id = ${body.leadId} AND deleted_at IS NULL`,
    );
    if (!lead.rows[0]) throw notFound("LEAD_NOT_FOUND", "LUME couldn't find that lead.");
    await req.db.execute(
      sql`UPDATE meetings SET lead_id = ${body.leadId}, updated_at = now(), version = version + 1 WHERE id = ${id}`,
    );
    await audit(req, { action: "meeting.attached", entityType: "meeting", entityId: id, diff: {} });
  }
  if (body.status !== undefined || body.outcomeNote !== undefined) {
    if (!body.status) throw badRequest("OUTCOME_STATUS", "Say how the meeting went.");
    if (m.status !== "scheduled") throw await recorded(req, id);
    if (new Date(m.startsAt) > d.clock())
      throw new HttpError(409, "MEETING_NOT_YET", "This meeting hasn't started yet.");
    const [done] = (
      await req.db.execute<{ outcome_task_id: string | null; lead_id: string | null }>(
        sql`UPDATE meetings SET status = ${body.status}, outcome_note = ${body.outcomeNote ?? null},
              outcome_at = ${d.clock()}, outcome_by = ${a.userId}, updated_at = now(), version = version + 1
            WHERE id = ${id} AND status = 'scheduled' RETURNING outcome_task_id, lead_id`,
      )
    ).rows;
    // Someone else logged it in the same moment (5D Review Focus 4): theirs stands, and this one is told.
    if (!done) throw await recorded(req, id);
    if (done?.outcome_task_id) {
      const t = await req.db.execute<{ id: string }>(
        sql`UPDATE tasks SET status = 'done', done_at = ${d.clock()}, done_by = ${a.userId}, updated_at = now(),
              version = version + 1
            WHERE id = ${done.outcome_task_id} AND status = 'open' RETURNING id`,
      );
      if (t.rows[0]) {
        await cancelReminders(req.db, t.rows[0].id);
        if (done.lead_id) await refreshNextDue(req, done.lead_id);
      }
    }
    await audit(req, {
      action: "meeting.outcome",
      entityType: "meeting",
      entityId: id,
      diff: { status: body.status },
    });
  }
  return one(req, id);
}

const OUTCOME_WORDS: Record<string, string> = {
  completed: "Held",
  no_show: "No-show",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
};

/** "Riya Rep already logged this meeting: No-show." — who, and how it went, for the person who tried second. */
async function recorded(req: FastifyRequest, id: string): Promise<HttpError> {
  const [row] = (
    await req.db.execute<{ status: string; name: string | null }>(
      sql`SELECT m.status, u.name FROM meetings m LEFT JOIN users u ON u.id = m.outcome_by WHERE m.id = ${id}`,
    )
  ).rows;
  const status = row?.status ?? "completed";
  const by = row?.name ?? "Someone";
  return new HttpError(
    409,
    "OUTCOME_RECORDED",
    `${by} already logged this meeting: ${OUTCOME_WORDS[status] ?? status}.`,
    { by, status },
  );
}
