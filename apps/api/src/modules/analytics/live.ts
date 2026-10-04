import { sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Range } from "@lume/core";
import { badRequest } from "../../http/errors";
import { frag, type DrillSpec } from "./drill";
import { LIVE_MAX_DAYS, isLive, liveFilter } from "./filters";
import type { AnalyticsQuery } from "./service";

/**
 * Numbers under a tag or field filter (8D spec §4 Filters). Rollups don't carry tags or fields, so these read the
 * leads, bounded to 92 days. They count with the drill-down definitions (drill.ts `frag`), the same ones the fixture
 * proves equal to the rollups, and in the rollups' own terms (who is credited, what counts as on time): a filter
 * that keeps every lead changes nothing.
 */
export function guardLive(q: AnalyticsQuery, range: Range): void {
  if (isLive(q) && range.days.length > LIVE_MAX_DAYS)
    throw badRequest(
      "RANGE_TOO_LONG_FOR_FILTER",
      "Narrow the range to 92 days or less to use tags or fields.",
    );
}
/** Boards without a live path say so rather than ignore the filter. */
export function refuseLive(q: AnalyticsQuery): void {
  if (isLive(q))
    throw badRequest("FILTER_NOT_SUPPORTED", "This board can't be filtered by tags or fields yet.");
}

type Scoped = DrillSpec & { q: DrillSpec["q"] & { reach?: string | null } };
/** A span as the drill fragments take it. */
export function spanOf(q: AnalyticsQuery, span: { from: Date; to: Date; days: string[] }): Scoped {
  return {
    k: "new_leads",
    d: [span.days[0]!, span.days.at(-1)!],
    t: [span.from.toISOString(), span.to.toISOString()],
    q: {
      ...(q.pipelineId ? { pipelineId: q.pipelineId } : {}),
      ...(q.ownerIds?.length ? { ownerIds: q.ownerIds } : {}),
      ...(q.sourceIds?.length ? { sourceIds: q.sourceIds } : {}),
      ...(q.tagIds?.length ? { tagIds: q.tagIds } : {}),
      ...(q.fields ? { fields: q.fields } : {}),
      reach: q.reach ?? null,
    },
    u: "",
    exp: 0,
  };
}

export type LiveCohort = {
  arrived: number;
  contacted: number;
  replied: number;
  won: number;
  within1h: number;
  within24h: number;
  speed: number | null;
};
export type LiveEvents = {
  won: number;
  wonValue: number;
  wonNoValue: number;
  lost: number;
  booked: number;
  held: number;
  noShow: number;
  tasksDue: number;
  tasksDone: number;
  onTime: number;
  lateMinutes: number;
  lateCount: number;
};

/** Minutes from arrival (or first assignment, for a lead that arrived unowned) to first contact, as rollups count. */
const MINS = sql`CASE WHEN f.first_contact_at IS NULL THEN NULL
  ELSE greatest(0, extract(epoch FROM f.first_contact_at -
    CASE WHEN lume_owner_at(l.id, l.created_at, l.owner_id) IS NULL THEN coalesce(lume_first_assigned(l.id), l.created_at)
         ELSE l.created_at END) / 60) END`;

export async function liveCohort(req: FastifyRequest, s: Scoped): Promise<LiveCohort> {
  const r = await req.db.execute<LiveCohort>(sql`
    SELECT count(*)::int AS arrived, count(*) FILTER (WHERE x.contact)::int AS contacted,
           count(*) FILTER (WHERE x.contact AND x.reply)::int AS replied, count(*) FILTER (WHERE x.won)::int AS won,
           count(*) FILTER (WHERE x.mins < 60)::int AS "within1h", count(*) FILTER (WHERE x.mins < 1440)::int AS "within24h",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY x.mins)::float8 AS speed
    FROM (SELECT f.first_contact_at IS NOT NULL AS contact, f.first_reply_at IS NOT NULL AS reply,
                 l.won_at IS NOT NULL AS won, ${MINS} AS mins
          FROM leads l LEFT JOIN lead_firsts f ON f.lead_id = l.id
          WHERE ${frag.leads(s)} AND ${frag.cohort(s)}) x`);
  return r.rows[0]!;
}

export async function liveEvents(req: FastifyRequest, s: Scoped): Promise<LiveEvents> {
  const span = (col: SQL) => frag.span(s, col);
  const [won, lost, meetings, tasks] = await Promise.all([
    req.db.execute<{ won: number; value: number; none: number }>(sql`
      SELECT count(*)::int AS won, coalesce(sum(l.value), 0)::float8 AS value, count(*) FILTER (WHERE l.value IS NULL)::int AS none
      FROM leads l WHERE ${frag.leads(s)} AND ${frag.won(s)}`),
    req.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM leads l WHERE ${frag.leads(s)} AND ${frag.lost(s)}`),
    req.db.execute<{ booked: number; held: number; no_show: number }>(sql`
      SELECT count(*) FILTER (WHERE ${span(sql`m.created_at`)} AND m.status <> 'rescheduled')::int AS booked,
             count(*) FILTER (WHERE ${span(sql`m.starts_at`)} AND m.status = 'completed')::int AS held,
             count(*) FILTER (WHERE ${span(sql`m.starts_at`)} AND m.status = 'no_show')::int AS no_show
      FROM meetings m JOIN leads l ON l.id = m.lead_id
      WHERE ${frag.leads(s)} AND ${frag.credit(sql`m.owner_id`, s.q)}
        AND (${span(sql`m.created_at`)} OR ${span(sql`m.starts_at`)})`),
    req.db.execute<{ due: number; done: number; on_time: number; late_minutes: number; late: number }>(sql`
      SELECT count(*)::int AS due, count(*) FILTER (WHERE t.status = 'done')::int AS done,
             count(*) FILTER (WHERE t.status = 'done' AND t.done_at <= t.due_at + interval '5 minutes')::int AS on_time,
             coalesce(sum(extract(epoch FROM t.done_at - t.due_at) / 60)
               FILTER (WHERE t.status = 'done' AND t.done_at > t.due_at + interval '5 minutes'), 0)::float8 AS late_minutes,
             count(*) FILTER (WHERE t.status = 'done' AND t.done_at > t.due_at + interval '5 minutes')::int AS late
      FROM tasks t JOIN leads l ON l.id = t.lead_id
      WHERE ${frag.leads(s)} AND ${span(sql`t.due_at`)} AND ${frag.credit(sql`t.assignee_id`, s.q)}`),
  ]);
  const w = won.rows[0]!;
  const m = meetings.rows[0]!;
  const t = tasks.rows[0]!;
  return {
    won: w.won,
    wonValue: w.value,
    wonNoValue: w.none,
    lost: lost.rows[0]!.n,
    booked: m.booked,
    held: m.held,
    noShow: m.no_show,
    tasksDue: t.due,
    tasksDone: t.done,
    onTime: t.on_time,
    // Rollups keep late minutes as a rounded sum per day; the mean of exact minutes differs by under a minute.
    lateMinutes: t.late_minutes,
    lateCount: t.late,
  };
}

/** New leads and wins per business day under a live filter, and new leads per source, for the Overview's chart. */
export async function liveDaily(req: FastifyRequest, s: Scoped, tz: string) {
  const [arr, won, split] = await Promise.all([
    req.db.execute<{ day: string; n: number }>(sql`
      SELECT to_char(coalesce(l.lead_created_at, (l.created_at AT TIME ZONE ${tz})::date), 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM leads l WHERE ${frag.leads(s)} AND ${frag.cohort(s)} GROUP BY 1`),
    req.db.execute<{ day: string; n: number }>(sql`
      SELECT to_char((l.won_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM leads l WHERE ${frag.leads(s)} AND ${frag.won(s)} GROUP BY 1`),
    req.db.execute<{ day: string; source_id: string | null; name: string | null; n: number }>(sql`
      SELECT to_char(coalesce(l.lead_created_at, (l.created_at AT TIME ZONE ${tz})::date), 'YYYY-MM-DD') AS day,
             l.source_id, ls.name, count(*)::int AS n
      FROM leads l LEFT JOIN lead_sources ls ON ls.id = l.source_id
      WHERE ${frag.leads(s)} AND ${frag.cohort(s)} GROUP BY 1, 2, 3`),
  ]);
  return { arrived: arr.rows, won: won.rows, split: split.rows };
}

export { isLive, liveFilter };
