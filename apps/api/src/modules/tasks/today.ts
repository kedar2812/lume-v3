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
  const out = { overdue, soon, later, done: doneToday, total: doneToday + all.length };
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
