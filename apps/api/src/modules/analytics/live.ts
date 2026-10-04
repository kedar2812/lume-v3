import { sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Range } from "@lume/core";
import { badRequest } from "../../http/errors";
import { frag, type DrillSpec } from "./drill";
import { LIVE_MAX_DAYS, isLive, liveFilter } from "./filters";
import { liveLead, liveOwner, type AnalyticsQuery } from "./service";

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

/**
 * Time in stage, read from the stage history under a filter its rollup (analytics_daily_stage) doesn't carry: a
 * source, tag or field. The rollup's own definition (0053): each move out of a stage in the span is a stay that ended,
 * as long as since the lead's move before it (or its arrival), credited to the owner at the move, in its buckets.
 */
export async function liveStays(req: FastifyRequest, q: AnalyticsQuery, span: { from: Date; to: Date }) {
  return req.db.execute<{ stage_id: string; name: string; exited: number; h: number[] }>(sql`
    SELECT x.stage_id, st.name, count(*)::int AS exited,
           ARRAY[${sql.raw("count(*) FILTER (WHERE x.b = 0), count(*) FILTER (WHERE x.b = 1), count(*) FILTER (WHERE x.b = 2), count(*) FILTER (WHERE x.b = 3), count(*) FILTER (WHERE x.b = 4), count(*) FILTER (WHERE x.b = 5), count(*) FILTER (WHERE x.b = 6), count(*) FILTER (WHERE x.b = 7), count(*) FILTER (WHERE x.b = 8), count(*) FILTER (WHERE x.b = 9), count(*) FILTER (WHERE x.b = 10), count(*) FILTER (WHERE x.b = 11)")}]::int[] AS h
    FROM (
      SELECT h.from_stage_id AS stage_id, width_bucket(s.mins, ${STAY_EDGES}::float8[]) AS b
      FROM lead_stage_history h JOIN leads l ON l.id = h.lead_id
      CROSS JOIN LATERAL (
        SELECT greatest(0, extract(epoch FROM h.changed_at - coalesce(
                 (SELECT p.changed_at FROM lead_stage_history p WHERE p.lead_id = h.lead_id AND p.changed_at < h.changed_at
                  ORDER BY p.changed_at DESC, p.id DESC LIMIT 1), l.created_at)) / 60) AS mins
      ) s
      WHERE h.changed_at >= ${span.from.toISOString()}::timestamptz AND h.changed_at < ${span.to.toISOString()}::timestamptz
        AND h.from_stage_id IS NOT NULL AND ${liveLead(q)}
        AND ${liveOwner(q, sql`lume_owner_at(l.id, h.changed_at, l.owner_id)`)}
    ) x JOIN stages st ON st.id = x.stage_id
    GROUP BY x.stage_id, st.name, st.position ORDER BY st.position`);
}
/** The stay buckets' edges in minutes, as lume_rollup_day keeps them. */
const STAY_EDGES = "{5,15,30,60,120,240,480,1440,2880,4320,10080}";

/**
 * The timing heatmaps, read from the leads under a filter their rollup (analytics_daily_slot) doesn't carry: a
 * source or a pipeline. The rollup's own definition (0053): arrivals by when they arrived (credited to the owner
 * then), messages sent and those answered within 72 hours (to whoever sent them), calls booked and held by when they
 * were due (to the calendar's owner); by weekday and hour in the business's time.
 */
export async function liveSlots(
  req: FastifyRequest,
  q: AnalyticsQuery,
  span: { from: Date; to: Date },
  tz: string,
) {
  const f = span.from.toISOString();
  const t = span.to.toISOString();
  const within = (col: SQL) => sql`${col} >= ${f}::timestamptz AND ${col} < ${t}::timestamptz`;
  const sent = sql`activities a JOIN leads l ON l.id = a.lead_id
    WHERE a.type = 'whatsapp_confirmed_sent' AND ${within(sql`a.occurred_at`)} AND ${liveLead(q)}`;
  const calls = sql`meetings m JOIN leads l ON l.id = m.lead_id WHERE ${within(sql`m.starts_at`)} AND ${liveLead(q)}`;
  return req.db.execute<{ kind: string; dow: number; hour: number; n: number }>(sql`
    SELECT z.kind, extract(dow FROM z.at AT TIME ZONE ${tz})::int AS dow,
           extract(hour FROM z.at AT TIME ZONE ${tz})::int AS hour, count(*)::int AS n
    FROM (
      SELECT 'arrivals' AS kind, l.created_at AS at, lume_owner_at(l.id, l.created_at, l.owner_id) AS who
      FROM leads l WHERE ${within(sql`l.created_at`)} AND ${liveLead(q)}
      UNION ALL
      SELECT 'sends', a.occurred_at, a.user_id FROM ${sent}
      UNION ALL
      SELECT 'replies', a.occurred_at, a.user_id FROM ${sent}
        AND EXISTS (SELECT 1 FROM activities r WHERE r.lead_id = a.lead_id AND r.type = 'reply_logged'
                    AND r.occurred_at > a.occurred_at AND r.occurred_at <= a.occurred_at + interval '72 hours')
      UNION ALL
      SELECT 'booked', m.starts_at, m.owner_id FROM ${calls} AND m.status IN ('scheduled', 'completed', 'no_show')
      UNION ALL
      SELECT 'held', m.starts_at, m.owner_id FROM ${calls} AND m.status = 'completed'
    ) z
    WHERE ${liveOwner(q, sql`z.who`)}
    GROUP BY 1, 2, 3`);
}
