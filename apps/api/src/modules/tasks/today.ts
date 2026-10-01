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
  }>(sql`
    SELECT m.id, m.title, m.starts_at, m.ends_at, m.link, m.status, l.id AS lead_id, l.name AS lead_name
      FROM meetings m LEFT JOIN leads l ON l.id = m.lead_id AND l.deleted_at IS NULL
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
  }));
  const out = { overdue, soon, later, done: doneToday, total: doneToday + all.length, meetings };
  if (!can(actor, "leads.view", "all")) return out;
  const unassigned = await req.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM leads l JOIN stages s ON s.id = l.stage_id
     WHERE l.owner_id IS NULL AND l.deleted_at IS NULL AND s.kind = 'open'`);
  const sources = await req.db
    .select({ id: schema.leadSources.id, name: schema.leadSources.name, type: schema.leadSources.type })
    .from(schema.leadSources)
    .where(eq(schema.leadSources.status, "needs_attention"));
  return { ...out, needsYou: { unassigned: unassigned.rows[0]!.n, sources } };
}
