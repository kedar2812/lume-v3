import { sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  METRICS,
  can,
  quantileFromHist,
  resolveRange,
  scopeOf,
  trend,
  type MetricId,
  type Range,
  type RangePreset,
  type Trend,
} from "@lume/core";
import { badRequest, forbidden } from "../../http/errors";

/**
 * The analytics API's numbers (8A, spec §4–§5.2). Dashboards read the daily rollups (0053) under the viewer's
 * analytics reach; "now" numbers (overdue, forecast) and medians that need each lead (days to win) read live tables,
 * bounded by the same reach. Every number follows the metric catalogue's definition.
 */
export type AnalyticsQuery = {
  range: RangePreset;
  from?: string;
  to?: string;
  compare: boolean;
  pipelineId?: string;
  ownerId?: string;
  sourceId?: string;
};
export type Tile = {
  id: MetricId;
  value: number | null;
  previous: number | null;
  trend: Trend | null;
  /** The count behind a rate, so a screen can say "too few to say". */
  n?: number;
  /** A side note the tile carries ("12 won without a value"). */
  note?: string;
};

export const TOO_FEW = 10;

export async function businessTz(req: FastifyRequest): Promise<string> {
  const r = await req.db.execute<{ timezone: string | null }>(
    sql`SELECT timezone FROM settings WHERE id = 1`,
  );
  return r.rows[0]?.timezone ?? "UTC";
}

export function rangeOf(q: AnalyticsQuery, tz: string, now: Date): Range {
  try {
    return resolveRange(q.range, tz, now, q.from && q.to ? { from: q.from, to: q.to } : undefined);
  } catch (e) {
    throw badRequest("BAD_RANGE", (e as Error).message);
  }
}

/** The viewer's reach, and an owner filter checked against it: a filter past one's reach is refused, not emptied. */
export function reachOf(req: FastifyRequest, ownerId?: string): "own" | "team" | "all" {
  const actor = req.actor!;
  const scope = scopeOf(actor, "analytics.view");
  if (!scope) throw forbidden();
  if (ownerId && scope !== "all") {
    const mine = ownerId === actor.userId;
    const team = scope === "team" && actor.teamMemberIds.includes(ownerId);
    if (!mine && !team) throw forbidden("OUTSIDE_REACH", "That person's numbers aren't yours to see.");
  }
  return scope;
}

export const seesRevenue = (req: FastifyRequest) => can(req.actor!, "analytics.revenue");

/** Rollup filters as SQL; the viewer's reach is the rollups' own row-level security. */
function rollupWhere(
  q: AnalyticsQuery,
  from: string,
  to: string,
  opts: { pipelineNullable?: boolean } = {},
): SQL {
  const parts: SQL[] = [sql`day BETWEEN ${from}::date AND ${to}::date`];
  if (q.pipelineId) parts.push(sql`pipeline_id = ${q.pipelineId}::uuid`);
  else if (opts.pipelineNullable) parts.push(sql`true`);
  if (q.sourceId) parts.push(sql`source_id = ${q.sourceId}::uuid`);
  if (q.ownerId) parts.push(q.ownerId === "none" ? sql`user_id IS NULL` : sql`user_id = ${q.ownerId}::uuid`);
  return sql.join(parts, sql` AND `);
}

type CohortSums = {
  arrived: number;
  contacted: number;
  replied: number;
  won: number;
  within1h: number;
  within24h: number;
  hist: number[];
};
type EventSums = {
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
  sends: number;
  replies72: number;
};

const H = Array.from({ length: 12 }, (_, i) => i + 1);
const histCols = sql.raw(H.map((i) => `coalesce(sum(speed_hist[${i}]), 0)::int AS h${i}`).join(", "));

export async function cohortSums(
  req: FastifyRequest,
  q: AnalyticsQuery,
  days: string[],
): Promise<CohortSums> {
  const r = await req.db.execute<Record<string, number>>(sql`
    SELECT coalesce(sum(arrived), 0)::int AS arrived, coalesce(sum(contacted), 0)::int AS contacted,
           coalesce(sum(replied), 0)::int AS replied, coalesce(sum(won), 0)::int AS won,
           coalesce(sum(within_1h), 0)::int AS within1h, coalesce(sum(within_24h), 0)::int AS within24h, ${histCols}
    FROM analytics_daily_cohort WHERE ${rollupWhere(q, days[0]!, days.at(-1)!)}`);
  const row = r.rows[0]!;
  return {
    arrived: row.arrived!,
    contacted: row.contacted!,
    replied: row.replied!,
    won: row.won!,
    within1h: row.within1h!,
    within24h: row.within24h!,
    hist: H.map((i) => row[`h${i}`]!),
  };
}

export async function eventSums(req: FastifyRequest, q: AnalyticsQuery, days: string[]): Promise<EventSums> {
  const r = await req.db.execute<Record<string, string | number>>(sql`
    SELECT coalesce(sum(won), 0)::int AS won, coalesce(sum(won_value), 0)::float8 AS "wonValue",
           coalesce(sum(won_no_value), 0)::int AS "wonNoValue", coalesce(sum(lost), 0)::int AS lost,
           coalesce(sum(booked), 0)::int AS booked, coalesce(sum(held), 0)::int AS held,
           coalesce(sum(no_show), 0)::int AS "noShow", coalesce(sum(tasks_due), 0)::int AS "tasksDue",
           coalesce(sum(tasks_done), 0)::int AS "tasksDone", coalesce(sum(tasks_on_time), 0)::int AS "onTime",
           coalesce(sum(late_minutes_sum), 0)::float8 AS "lateMinutes", coalesce(sum(late_count), 0)::int AS "lateCount",
           coalesce(sum(sends), 0)::int AS sends, coalesce(sum(replies72), 0)::int AS replies72
    FROM analytics_daily_event WHERE ${rollupWhere(q, days[0]!, days.at(-1)!, { pipelineNullable: true })}`);
  const row = r.rows[0]!;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as EventSums;
}

/** Live "now" conditions, bounded by the viewer's analytics reach as the rollups are. */
function liveOwner(q: AnalyticsQuery, col: SQL): SQL {
  const parts: SQL[] = [sql`lume_sees_credit(${col})`];
  if (q.ownerId) parts.push(q.ownerId === "none" ? sql`${col} IS NULL` : sql`${col} = ${q.ownerId}::uuid`);
  return sql.join(parts, sql` AND `);
}
function liveLead(q: AnalyticsQuery): SQL {
  const parts: SQL[] = [sql`l.deleted_at IS NULL`];
  if (q.pipelineId) parts.push(sql`l.pipeline_id = ${q.pipelineId}::uuid`);
  if (q.sourceId) parts.push(sql`l.source_id = ${q.sourceId}::uuid`);
  return sql.join(parts, sql` AND `);
}

export async function overdueNow(req: FastifyRequest, q: AnalyticsQuery): Promise<number> {
  const r = await req.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM tasks t JOIN leads l ON l.id = t.lead_id
    WHERE t.status = 'open' AND t.due_at < now() AND ${liveLead(q)} AND ${liveOwner(q, sql`t.assignee_id`)}`);
  return r.rows[0]!.n;
}

export async function forecastNow(req: FastifyRequest, q: AnalyticsQuery): Promise<number> {
  const r = await req.db.execute<{ v: number }>(sql`
    SELECT coalesce(sum(l.value * coalesce(s.win_probability, 0) / 100), 0)::float8 AS v
    FROM leads l JOIN stages s ON s.id = l.stage_id
    WHERE s.kind = 'open' AND l.value IS NOT NULL AND ${liveLead(q)} AND ${liveOwner(q, sql`l.owner_id`)}`);
  return r.rows[0]!.v;
}

/** Median days from arrival to winning, for leads won in the span, credited to the owner when won. */
export async function cycleDays(req: FastifyRequest, q: AnalyticsQuery, from: Date, to: Date, tz: string) {
  const r = await req.db.execute<{ m: number | null }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM l.won_at -
             coalesce(l.lead_created_at::timestamp AT TIME ZONE ${tz}, l.created_at)) / 86400)::float8 AS m
    FROM leads l
    WHERE l.won_at >= ${from.toISOString()}::timestamptz AND l.won_at < ${to.toISOString()}::timestamptz
      AND ${liveLead(q)} AND ${liveOwner(q, sql`lume_owner_at(l.id, l.won_at, l.owner_id)`)}`);
  return r.rows[0]?.m ?? null;
}

const rate = (a: number, b: number) => (b > 0 ? a / b : null);

function tile(
  id: MetricId,
  value: number | null,
  previous: number | null,
  compare: boolean,
  extra: Partial<Tile> = {},
): Tile {
  const m = METRICS[id];
  return {
    id,
    value,
    previous: compare ? previous : null,
    trend:
      compare && value !== null && previous !== null
        ? trend(value, previous, { kind: m.trendKind, good: m.good })
        : null,
    // A side note only when there's something to say.
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
  };
}

/** The Overview module (canvas Main): the funnel's health, the team's follow-through, the money. */
export async function overview(req: FastifyRequest, q: AnalyticsQuery, now: Date) {
  reachOf(req, q.ownerId);
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  const [c, e, pc, pe, overdue, cyc, pcyc] = await Promise.all([
    cohortSums(req, q, range.days),
    eventSums(req, q, range.days),
    cohortSums(req, q, range.previous.days),
    eventSums(req, q, range.previous.days),
    overdueNow(req, q),
    cycleDays(req, q, range.from, range.to, tz),
    cycleDays(req, q, range.previous.from, range.previous.to, tz),
  ]);
  const money = seesRevenue(req);
  const valued = e.won - e.wonNoValue;
  const pValued = pe.won - pe.wonNoValue;
  const tiles: Tile[] = [
    tile("new_leads", c.arrived, pc.arrived, q.compare),
    tile("contacted", rate(c.contacted, c.arrived), rate(pc.contacted, pc.arrived), q.compare, {
      n: c.arrived,
    }),
    tile("reply_rate", rate(c.replied, c.contacted), rate(pc.replied, pc.contacted), q.compare, {
      n: c.contacted,
    }),
    tile("speed_to_lead", quantileFromHist(c.hist, 0.5), quantileFromHist(pc.hist, 0.5), q.compare, {
      n: c.contacted,
      note: c.arrived > c.contacted ? `${c.arrived - c.contacted} not contacted yet` : undefined,
    }),
    tile("calls_booked", e.booked, pe.booked, q.compare),
    tile("calls_held", e.held, pe.held, q.compare),
    tile("no_show_rate", rate(e.noShow, e.held + e.noShow), rate(pe.noShow, pe.held + pe.noShow), q.compare, {
      n: e.held + e.noShow,
    }),
    tile("won", e.won, pe.won, q.compare),
    tile("win_rate", rate(c.won, c.arrived), rate(pc.won, pc.arrived), q.compare, { n: c.arrived }),
    tile("overdue_now", overdue, null, false),
    tile("ontime", rate(e.onTime, e.tasksDone), rate(pe.onTime, pe.tasksDone), q.compare, { n: e.tasksDone }),
    tile(
      "lateness",
      e.lateCount ? e.lateMinutes / e.lateCount : null,
      pe.lateCount ? pe.lateMinutes / pe.lateCount : null,
      q.compare,
      {
        n: e.lateCount,
      },
    ),
    tile("cycle", cyc, pcyc, q.compare, { n: e.won }),
    tile("lost", e.lost, pe.lost, q.compare),
  ];
  if (money)
    tiles.push(
      tile("revenue_won", e.wonValue, pe.wonValue, q.compare, {
        note: e.wonNoValue ? `${e.wonNoValue} won without a value` : undefined,
      }),
      tile(
        "avg_deal",
        valued ? e.wonValue / valued : null,
        pValued ? pe.wonValue / pValued : null,
        q.compare,
        { n: valued },
      ),
      tile("forecast", await forecastNow(req, q), null, false),
    );
  return {
    range: { label: range.label, days: range.days, from: range.from, to: range.to, previous: range.previous },
    tiles,
    series: await dailySeries(req, q, range),
  };
}

/** New leads and wins per day, this period and the one before, for the chart. */
export async function dailySeries(req: FastifyRequest, q: AnalyticsQuery, range: Range) {
  const read = async (days: string[]) => {
    const [arr, won] = await Promise.all([
      req.db.execute<{ day: string; n: number }>(sql`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(arrived)::int AS n FROM analytics_daily_cohort
        WHERE ${rollupWhere(q, days[0]!, days.at(-1)!)} GROUP BY day`),
      req.db.execute<{ day: string; n: number }>(sql`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(won)::int AS n FROM analytics_daily_event
        WHERE ${rollupWhere(q, days[0]!, days.at(-1)!, { pipelineNullable: true })} GROUP BY day`),
    ]);
    const a = new Map(arr.rows.map((r) => [r.day, r.n]));
    const w = new Map(won.rows.map((r) => [r.day, r.n]));
    return { newLeads: days.map((d) => a.get(d) ?? 0), won: days.map((d) => w.get(d) ?? 0) };
  };
  const [now, before] = await Promise.all([read(range.days), read(range.previous.days)]);
  return { days: range.days, ...now, previous: before };
}

/**
 * The funnel (canvas Funnel): for the leads that arrived in the range, the share that reached each stage or a later
 * one, open stages in order and then won.
 */
export async function funnel(req: FastifyRequest, q: AnalyticsQuery, now: Date) {
  reachOf(req, q.ownerId);
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  const pipeline =
    q.pipelineId ??
    (
      await req.db.execute<{ id: string }>(
        sql`SELECT id FROM pipelines WHERE archived_at IS NULL ORDER BY is_default DESC, position LIMIT 1`,
      )
    ).rows[0]?.id;
  if (!pipeline) return { range: { label: range.label }, stages: [], arrived: 0 };
  const scoped = { ...q, pipelineId: pipeline };
  const stages = (
    await req.db.execute<{ id: string; name: string; kind: string }>(sql`
      SELECT id, name, kind FROM stages WHERE pipeline_id = ${pipeline}::uuid AND kind IN ('open', 'won')
        AND archived_at IS NULL
      ORDER BY (kind = 'won'), position`)
  ).rows;
  const reach = async (days: string[]) =>
    new Map(
      (
        await req.db.execute<{ stage_id: string; n: number }>(sql`
          SELECT stage_id, sum(n)::int AS n FROM analytics_daily_reach WHERE ${rollupWhere(scoped, days[0]!, days.at(-1)!)}
          GROUP BY stage_id`)
      ).rows.map((r) => [r.stage_id, r.n]),
    );
  const [cur, prev, c, pc] = await Promise.all([
    reach(range.days),
    reach(range.previous.days),
    cohortSums(req, scoped, range.days),
    cohortSums(req, scoped, range.previous.days),
  ]);
  // Reached stage k or later: the leads whose furthest stage is k or beyond.
  const orLater = (m: Map<string, number>, i: number) =>
    stages.slice(i).reduce((a, s) => a + (m.get(s.id) ?? 0), 0);
  return {
    range: { label: range.label, days: range.days },
    arrived: c.arrived,
    previousArrived: pc.arrived,
    stages: stages.map((s, i) => {
      const reached = orLater(cur, i);
      const before = orLater(prev, i);
      const share = rate(reached, c.arrived);
      const prevShare = rate(before, pc.arrived);
      return {
        id: s.id,
        name: s.name,
        kind: s.kind,
        reached,
        share,
        // Of those that reached this stage, the share that went no further (it's their furthest).
        stopped: reached ? (cur.get(s.id) ?? 0) / reached : null,
        tooFew: reached < TOO_FEW,
        trend:
          q.compare && share !== null && prevShare !== null
            ? trend(share, prevShare, { kind: "pts", good: "up" })
            : null,
      };
    }),
  };
}

/** Each person (canvas Team): their own numbers side by side, for a viewer who sees more than themselves. */
export async function team(req: FastifyRequest, q: AnalyticsQuery, now: Date) {
  const scope = reachOf(req, q.ownerId);
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  const [from, to] = [range.days[0]!, range.days.at(-1)!];
  const [cohort, events, overdue, people] = await Promise.all([
    req.db.execute<{
      user_id: string | null;
      arrived: number;
      contacted: number;
      won_so_far: number;
      h: number[];
    }>(sql`
      SELECT user_id, sum(arrived)::int AS arrived, sum(contacted)::int AS contacted, sum(won)::int AS won_so_far,
             ARRAY[${sql.raw(H.map((i) => `coalesce(sum(speed_hist[${i}]), 0)::int`).join(", "))}] AS h
      FROM analytics_daily_cohort WHERE ${rollupWhere(q, from, to)} GROUP BY user_id`),
    req.db.execute<{
      user_id: string | null;
      won: number;
      won_value: number;
      done: number;
      on_time: number;
    }>(sql`
      SELECT user_id, sum(won)::int AS won, sum(won_value)::float8 AS won_value, sum(tasks_done)::int AS done,
             sum(tasks_on_time)::int AS on_time
      FROM analytics_daily_event WHERE ${rollupWhere(q, from, to, { pipelineNullable: true })} GROUP BY user_id`),
    req.db.execute<{ user_id: string; n: number }>(sql`
      SELECT t.assignee_id AS user_id, count(*)::int AS n FROM tasks t JOIN leads l ON l.id = t.lead_id
      WHERE t.status = 'open' AND t.due_at < now() AND ${liveLead(q)} AND ${liveOwner(q, sql`t.assignee_id`)}
      GROUP BY t.assignee_id`),
    req.db.execute<{ id: string; name: string; status: string }>(
      sql`SELECT id, name, status FROM users WHERE status <> 'invited'`,
    ),
  ]);
  const money = seesRevenue(req);
  const ids = new Set<string>([
    ...cohort.rows.flatMap((r) => (r.user_id ? [r.user_id] : [])),
    ...events.rows.flatMap((r) => (r.user_id ? [r.user_id] : [])),
    ...overdue.rows.map((r) => r.user_id),
  ]);
  const name = new Map(people.rows.map((p) => [p.id, p]));
  const rows = [...ids].map((id) => {
    const c = cohort.rows.find((r) => r.user_id === id);
    const e = events.rows.find((r) => r.user_id === id);
    return {
      id,
      name: name.get(id)?.name ?? "Someone",
      active: name.get(id)?.status === "active",
      newLeads: c?.arrived ?? 0,
      contacted: c ? rate(c.contacted, c.arrived) : null,
      speedToLead: c ? quantileFromHist(c.h, 0.5) : null,
      won: e?.won ?? 0,
      ...(money ? { revenueWon: e?.won_value ?? 0 } : {}),
      ontime: e ? rate(e.on_time, e.done) : null,
      overdueNow: overdue.rows.find((r) => r.user_id === id)?.n ?? 0,
    };
  });
  rows.sort((a, b) => b.won - a.won || b.newLeads - a.newLeads || a.name.localeCompare(b.name));
  return { range: { label: range.label, days: range.days }, leaderboard: scope !== "own", people: rows };
}
