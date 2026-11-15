import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

export type DayMeeting = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  link: string | null;
  status: string;
  lead: { id: string; name: string } | null;
  matchedBy: string;
  reminder: { at: string; sent: boolean } | null;
};

/**
 * A person's own calls starting in [start, end): not cancelled or moved, earliest first, each with its WhatsApp
 * reminder (5D). Today's calls (5C) and Your day's other days (spec: Your day full screen) read the same rule.
 */
export async function meetingsBetween(
  req: FastifyRequest,
  userId: string,
  start: Date,
  end: Date,
): Promise<DayMeeting[]> {
  const calls = await req.db.execute<{
    id: string;
    title: string;
    starts_at: string | Date;
    ends_at: string | Date;
    link: string | null;
    status: string;
    lead_id: string | null;
    lead_name: string | null;
    matched_by: string;
    reminder_status: string | null;
    reminder_due: string | Date | null;
    reminder_done: string | Date | null;
  }>(sql`
    SELECT m.id, m.title, m.starts_at, m.ends_at, m.link, m.status, l.id AS lead_id, l.name AS lead_name,
           m.matched_by, r.status AS reminder_status, r.due_at AS reminder_due, r.done_at AS reminder_done
      FROM meetings m LEFT JOIN leads l ON l.id = m.lead_id AND l.deleted_at IS NULL
      -- 5D: its WhatsApp reminder (the stage rule's), still to go or sent: the newest one.
      LEFT JOIN LATERAL (
        SELECT t.status, t.due_at, t.done_at FROM tasks t
         WHERE t.meeting_id = m.id AND t.type = 'whatsapp' AND t.status IN ('open', 'done')
         ORDER BY t.created_at DESC LIMIT 1
      ) r ON true
     WHERE m.owner_id = ${userId} AND m.status NOT IN ('cancelled', 'rescheduled')
       AND m.starts_at >= ${start} AND m.starts_at < ${end}
     ORDER BY m.starts_at, m.id`);
  return calls.rows.map((m) => ({
    id: m.id,
    title: m.title,
    startsAt: new Date(m.starts_at).toISOString(),
    endsAt: new Date(m.ends_at).toISOString(),
    link: m.link,
    status: m.status,
    lead: m.lead_id ? { id: m.lead_id, name: m.lead_name ?? "" } : null,
    matchedBy: m.matched_by,
    reminder: m.reminder_status
      ? m.reminder_status === "done" && m.reminder_done
        ? { at: new Date(m.reminder_done).toISOString(), sent: true }
        : { at: new Date(m.reminder_due!).toISOString(), sent: false }
      : null,
  }));
}
