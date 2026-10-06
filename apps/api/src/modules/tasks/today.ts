import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, localDayBounds } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { viewsOf } from "./service";

const T = schema.tasks;
const SOON_MS = 2 * 3_600_000;

/**
 * Today (Phase 3 spec §6), in the caller's own day: what's overdue, due within two hours, and later today,
 * and how much of today is done. Admins (every lead) also see what needs them.
 */
export async function today(req: FastifyRequest, d: AppDeps) {
  const actor = req.actor!;
  const now = d.clock();
  const { rows } = await req.db.execute<{ tz: string }>(
    sql`SELECT coalesce(u.timezone, s.timezone) AS tz FROM settings s LEFT JOIN users u ON u.id = ${actor.userId} WHERE s.id = 1`,
  );
  const { start, end } = localDayBounds(now, rows[0]?.tz ?? "UTC");
  const open = await req.db
    .select()
    .from(T)
    .where(and(eq(T.assigneeId, actor.userId), eq(T.status, "open"), lt(T.dueAt, end)))
    .orderBy(asc(T.dueAt));
  const all = await viewsOf(req, open);
  const at = (iso: string) => new Date(iso).getTime();
  const overdue = all.filter((t) => at(t.dueAt) < now.getTime());
  const soon = all.filter((t) => at(t.dueAt) >= now.getTime() && at(t.dueAt) < now.getTime() + SOON_MS);
  const later = all.filter((t) => at(t.dueAt) >= now.getTime() + SOON_MS);
  const done = await req.db
    .select({ n: sql<number>`count(*)::int` })
    .from(T)
    .where(and(eq(T.doneBy, actor.userId), eq(T.status, "done"), gte(T.doneAt, start), lt(T.doneAt, end)));
  const doneToday = done[0]!.n;
  // What was done today, with when each was due: the green dots on the day's line (control centre).
  const doneRows = await req.db
    .select()
    .from(T)
    .where(and(eq(T.assigneeId, actor.userId), eq(T.status, "done"), gte(T.doneAt, start), lt(T.doneAt, end)))
    .orderBy(asc(T.dueAt))
    .limit(200);
  const doneList = (await viewsOf(req, doneRows)).map((t) => ({
    id: t.id,
    title: t.title,
    dueAt: t.dueAt,
    leadId: t.leadId,
    leadName: t.leadName,
  }));
  // Today's calls (5C): the caller's own meetings starting today on their clock, not cancelled or moved.
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
     WHERE m.owner_id = ${actor.userId} AND m.status NOT IN ('cancelled', 'rescheduled')
       AND m.starts_at >= ${start} AND m.starts_at < ${end}
     ORDER BY m.starts_at, m.id`);
  const meetings = calls.rows.map((m) => ({
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
  const out = {
    overdue,
    soon,
    later,
    done: doneToday,
    total: doneToday + all.length,
    meetings,
    doneToday: doneList,
  };
  if (!can(actor, "leads.view", "all")) return out;
  // Read from the kept counts (0048, exact at every moment), not counted across every lead: 484 ms → a few at 1M.
  const unassigned = await req.db.execute<{ n: number }>(sql`
    SELECT coalesce(sum(c.n), 0)::int AS n FROM lead_counts_now c JOIN stages s ON s.id = c.stage_id
     WHERE c.owner_id IS NULL AND s.kind = 'open'`);
  // How long the oldest has waited (leads_unowned: an index read, the oldest first).
  const oldest = await req.db.execute<{ at: string | Date | null }>(sql`
    SELECT l.created_at AS at FROM leads l JOIN stages s ON s.id = l.stage_id
     WHERE l.owner_id IS NULL AND l.deleted_at IS NULL AND s.kind = 'open' ORDER BY l.created_at LIMIT 1`);
  const sources = await req.db
    .select({ id: schema.leadSources.id, name: schema.leadSources.name, type: schema.leadSources.type })
    .from(schema.leadSources)
    .where(eq(schema.leadSources.status, "needs_attention"));
  // Open security alerts, for whoever looks after security (frontend spec §8.2: admins see security alerts here).
  const alerts = can(actor, "security.manage")
    ? (
        await req.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM security_alerts WHERE status = 'open'`,
        )
      ).rows[0]!.n
    : 0;
  const oldestAt = oldest.rows[0]?.at;
  return {
    ...out,
    needsYou: {
      unassigned: unassigned.rows[0]!.n,
      unassignedOldest: oldestAt ? new Date(oldestAt).toISOString() : null,
      sources,
      alerts,
    },
  };
}
