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
import { isLive, liveFilter, ownerCond, sourceCond } from "./filters";
import { guardLive, liveCohort, liveDaily, liveEvents, spanOf, type LiveEvents } from "./live";

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
  /** People whose numbers to count ("none": leads nobody owns); a team arrives as its people. */
  ownerIds?: string[];
  sourceIds?: string[];
  /** Live-only filters (8D-1 Task 3): any of these tags; each field's value among those listed. */
  tagIds?: string[];
  fields?: Record<string, string[]>;
  /** The viewer's analytics reach, once checked (reachOf): 'all' with no owner filter needs no credit test per row. */
  reach?: "own" | "team" | "all";
  /** The owners are the viewer's own reach (narrow), not a filter they asked for. */
  narrowed?: boolean;
  /** The owners are this team's people (a team filter), for a drill token to name instead of listing them. */
  teamId?: string;
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
export function reachOf(req: FastifyRequest, ownerIds?: readonly string[]): "own" | "team" | "all" {
  const actor = req.actor!;
  const scope = scopeOf(actor, "analytics.view");
  if (!scope) throw forbidden();
  if (ownerIds?.length && scope !== "all")
    for (const id of ownerIds) {
      const mine = id === actor.userId;
      const team = scope === "team" && actor.teamMemberIds.includes(id);
      if (!mine && !team) throw forbidden("OUTSIDE_REACH", "That person's numbers aren't yours to see.");
    }
  return scope;
}

export const seesRevenue = (req: FastifyRequest) => can(req.actor!, "analytics.revenue");

const WIDTH = { own: 1, team: 2, all: 3 } as const;
/**
 * Numbers counted from the leads themselves (tags, fields, what converts) see only the leads the viewer can open
 * (their leads.view, by row-level security). Someone whose analytics reach is wider would get numbers that quietly
 * fall short of every other number they see: refused in words instead.
 */
export function assertLeadAccess(req: FastifyRequest, reach: "own" | "team" | "all"): void {
  const leads = scopeOf(req.actor!, "leads.view");
  if (!leads || WIDTH[leads] < WIDTH[reach])
    throw badRequest(
      "FILTER_NEEDS_LEAD_ACCESS",
      "Tags and fields are counted from the leads you can open, and you can open fewer than these numbers cover.",
    );
}

/**
 * The query at the viewer's reach. Someone who sees only their own (or their team's) numbers asks for exactly those
 * people's rows, which the rollups' per-person indexes (0059) find directly, instead of reading everyone's and
 * letting row-level security drop the rest. The rows and numbers are the same either way.
 */
export function narrow<Q extends AnalyticsQuery>(req: FastifyRequest, q: Q): Q {
  const reach = reachOf(req, q.ownerIds);
  if (isLive(q)) assertLeadAccess(req, reach);
  if (reach === "all" || q.ownerIds?.length) return { ...q, reach };
  const actor = req.actor!;
  const ownerIds = reach === "own" ? [actor.userId] : [...new Set([actor.userId, ...actor.teamMemberIds])];
  return { ...q, reach, ownerIds, narrowed: true };
}

/** Rollup filters as SQL; the viewer's reach is the rollups' own row-level security. */
export function rollupWhere(
  q: AnalyticsQuery,
  from: string,
  to: string,
  opts: { pipelineNullable?: boolean } = {},
): SQL {
  const parts: SQL[] = [sql`day BETWEEN ${from}::date AND ${to}::date`];
  if (q.pipelineId) parts.push(sql`pipeline_id = ${q.pipelineId}::uuid`);
  else if (opts.pipelineNullable) parts.push(sql`true`);
  const src = sourceCond(q.sourceIds, sql`source_id`);
  if (src) parts.push(src);
  const own = ownerCond(q.ownerIds, sql`user_id`);
  if (own) parts.push(own);
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
  cancelled: number;
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
           coalesce(sum(no_show), 0)::int AS "noShow", coalesce(sum(cancelled), 0)::int AS cancelled,
           coalesce(sum(tasks_due), 0)::int AS "tasksDue",
           coalesce(sum(tasks_done), 0)::int AS "tasksDone", coalesce(sum(tasks_on_time), 0)::int AS "onTime",
           coalesce(sum(late_minutes_sum), 0)::float8 AS "lateMinutes", coalesce(sum(late_count), 0)::int AS "lateCount",
           coalesce(sum(sends), 0)::int AS sends, coalesce(sum(replies72), 0)::int AS replies72
    FROM analytics_daily_event WHERE ${rollupWhere(q, days[0]!, days.at(-1)!, { pipelineNullable: true })}`);
  const row = r.rows[0]!;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as EventSums;
}

/** Live "now" conditions, bounded by the viewer's analytics reach as the rollups are. */
export function liveOwner(q: AnalyticsQuery, col: SQL): SQL {
  // Someone who sees everyone, filtering by no one: no per-lead credit to work out (it's the costly part at scale).
  if (q.reach === "all" && !q.ownerIds?.length) return sql`true`;
  const parts: SQL[] = [sql`lume_sees_credit(${col})`];
  const own = ownerCond(q.ownerIds, col);
  if (own) parts.push(own);
  return sql.join(parts, sql` AND `);
}
export function liveLead(q: AnalyticsQuery): SQL {
  const parts: SQL[] = [sql`l.deleted_at IS NULL`];
  if (q.pipelineId) parts.push(sql`l.pipeline_id = ${q.pipelineId}::uuid`);
  const src = sourceCond(q.sourceIds, sql`l.source_id`);
  if (src) parts.push(src);
  const tagged = liveFilter(q);
  if (tagged) parts.push(tagged);
  return sql.join(parts, sql` AND `);
}

/** Open follow-ups due before `now` (the app's clock, as every other number; the database's own now() could differ). */
export async function overdueNow(req: FastifyRequest, q: AnalyticsQuery, now: Date): Promise<number> {
  const r = await req.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM tasks t JOIN leads l ON l.id = t.lead_id
    WHERE t.status = 'open' AND t.due_at < ${now.toISOString()}::timestamptz AND ${liveLead(q)} AND ${liveOwner(q, sql`t.assignee_id`)}`);
  return r.rows[0]!.n;
}

export async function forecastNow(req: FastifyRequest, q: AnalyticsQuery): Promise<number> {
  // The kept stage counts (0048) already sum each stage's value per owner: a few rows, not every open lead. They
  // carry no source, so a source filter reads the leads themselves.
  if (!q.sourceIds?.length && !isLive(q)) {
    const k = await req.db.execute<{ v: number }>(sql`
      SELECT coalesce(sum(c.value * coalesce(s.win_probability, 0) / 100), 0)::float8 AS v
      FROM lead_counts_now c JOIN stages s ON s.id = c.stage_id
      WHERE s.kind = 'open' ${q.pipelineId ? sql`AND c.pipeline_id = ${q.pipelineId}::uuid` : sql``}
        AND ${liveOwner(q, sql`c.owner_id`)}`);
    return k.rows[0]!.v;
  }
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

/** Days to win, in the buckets velocity's histogram draws (Funnel board): under 1 day, 1–2, 2–3, 3–5 … a year and more. */
export const CYCLE_EDGES = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180, 365];

/** Wins between `from` and `to` by how long each took from arriving, in CYCLE_EDGES' buckets, and the median's bucket. */
export async function cycleHist(req: FastifyRequest, q: AnalyticsQuery, from: Date, to: Date, tz: string) {
  const r = await req.db.execute<{ b: number; n: number }>(sql`
    SELECT width_bucket(extract(epoch FROM l.won_at -
             coalesce(l.lead_created_at::timestamp AT TIME ZONE ${tz}, l.created_at)) / 86400,
             ${`{${CYCLE_EDGES.join(",")}}`}::float8[]) AS b, count(*)::int AS n
    FROM leads l
    WHERE l.won_at >= ${from.toISOString()}::timestamptz AND l.won_at < ${to.toISOString()}::timestamptz
      AND ${liveLead(q)} AND ${liveOwner(q, sql`lume_owner_at(l.id, l.won_at, l.owner_id)`)}
    GROUP BY 1`);
  const counts = Array<number>(CYCLE_EDGES.length + 1).fill(0);
  for (const row of r.rows) counts[row.b] = (counts[row.b] ?? 0) + row.n;
  const total = counts.reduce((a, n) => a + n, 0);
  let seen = 0;
  const median = total ? counts.findIndex((n) => (seen += n) >= total / 2) : null;
  return { edges: CYCLE_EDGES, counts, median };
}

export const rate = (a: number, b: number) => (b > 0 ? a / b : null);

export function tile(
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
  q = narrow(req, q);
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  const live = isLive(q);
  guardLive(q, range);
  // Under a tag or field filter the sums are read live, by the same definitions (live.ts).
  const sums = live
    ? Promise.all([
        liveCohort(req, spanOf(q, range)),
        liveEvents(req, spanOf(q, range)),
        liveCohort(req, spanOf(q, range.previous)),
        liveEvents(req, spanOf(q, range.previous)),
      ])
    : Promise.all([
        cohortSums(req, q, range.days),
        eventSums(req, q, range.days),
        cohortSums(req, q, range.previous.days),
        eventSums(req, q, range.previous.days),
      ]);
  const [[c, e, pc, pe], overdue, cyc, pcyc] = await Promise.all([
    sums,
    overdueNow(req, q, now),
    cycleDays(req, q, range.from, range.to, tz),
    cycleDays(req, q, range.previous.from, range.previous.to, tz),
  ]);
  const money = seesRevenue(req);
  const v = valuesOf(c, e, money);
  const pv = valuesOf(pc, pe, money);
  const t = (id: SummedTile, extra?: Parameters<typeof tile>[4]) =>
    tile(id, v[id] ?? null, pv[id] ?? null, q.compare, extra);
  const tiles: Tile[] = [
    t("new_leads"),
    t("contacted", { n: c.arrived }),
    t("reply_rate", { n: c.contacted }),
    t("speed_to_lead", {
      n: c.contacted,
      note: c.arrived > c.contacted ? `${c.arrived - c.contacted} not contacted yet` : undefined,
    }),
    t("calls_booked"),
    t("calls_held"),
    t("no_show_rate", { n: e.held + e.noShow }),
    t("won"),
    t("win_rate", { n: c.arrived }),
    tile("overdue_now", overdue, null, false),
    t("ontime", { n: e.tasksDone }),
    t("lateness", { n: e.lateCount }),
    tile("cycle", cyc, pcyc, q.compare, { n: e.won }),
    t("lost"),
  ];
  if (money)
    tiles.push(
      t("revenue_won", { note: e.wonNoValue ? `${e.wonNoValue} won without a value` : undefined }),
      t("avg_deal", { n: e.won - e.wonNoValue }),
      tile("forecast", await forecastNow(req, q), null, false),
    );
  const [series, lines] = await Promise.all([
    live ? liveSeries(req, q, range, tz) : dailySeries(req, q, range),
    // Each tile's daily line (the canvas's sparklines). Under a tag or field filter, only the two the chart reads.
    live ? null : tileLines(req, q, range.days, money),
  ]);
  return {
    range: { label: range.label, days: range.days, from: range.from, to: range.to, previous: range.previous },
    tiles,
    series: { ...series, tiles: lines ?? { new_leads: series.newLeads, won: series.won } },
  };
}

/** The tiles a period's sums answer on their own ("right now" numbers and the cycle are read apart). */
type SummedTile = Exclude<MetricId, "overdue_now" | "forecast" | "cycle">;
type AnySums = Omit<CohortSums, "hist"> & ({ hist: number[] } | { speed: number | null });

/** Each summed tile's value from one period's sums: the one definition the tiles and their daily lines share. */
function valuesOf(c: AnySums, e: LiveEvents, money: boolean): Partial<Record<SummedTile, number | null>> {
  const valued = e.won - e.wonNoValue;
  return {
    new_leads: c.arrived,
    contacted: rate(c.contacted, c.arrived),
    reply_rate: rate(c.replied, c.contacted),
    speed_to_lead: speedOf(c),
    calls_booked: e.booked,
    calls_held: e.held,
    no_show_rate: rate(e.noShow, e.held + e.noShow),
    won: e.won,
    win_rate: rate(c.won, c.arrived),
    ontime: rate(e.onTime, e.tasksDone),
    lateness: e.lateCount ? e.lateMinutes / e.lateCount : null,
    lost: e.lost,
    ...(money ? { revenue_won: e.wonValue, avg_deal: valued ? e.wonValue / valued : null } : {}),
  };
}

const EVENT_KEYS = [
  "won",
  "wonValue",
  "wonNoValue",
  "lost",
  "booked",
  "held",
  "noShow",
  "cancelled",
  "tasksDue",
  "tasksDone",
  "onTime",
  "lateMinutes",
  "lateCount",
  "sends",
  "replies72",
] as const;

/** Every summed tile, day by day, from the rollups: two reads grouped by day, whatever the range. */
async function tileLines(req: FastifyRequest, q: AnalyticsQuery, days: string[], money: boolean) {
  const [co, ev] = await Promise.all([
    req.db.execute<Record<string, number | string>>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, coalesce(sum(arrived), 0)::int AS arrived,
             coalesce(sum(contacted), 0)::int AS contacted, coalesce(sum(replied), 0)::int AS replied,
             coalesce(sum(won), 0)::int AS won, coalesce(sum(within_1h), 0)::int AS within1h,
             coalesce(sum(within_24h), 0)::int AS within24h, ${histCols}
      FROM analytics_daily_cohort WHERE ${rollupWhere(q, days[0]!, days.at(-1)!)} GROUP BY day`),
    req.db.execute<Record<string, number | string>>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, coalesce(sum(won), 0)::int AS won,
             coalesce(sum(won_value), 0)::float8 AS "wonValue", coalesce(sum(won_no_value), 0)::int AS "wonNoValue",
             coalesce(sum(lost), 0)::int AS lost, coalesce(sum(booked), 0)::int AS booked,
             coalesce(sum(held), 0)::int AS held, coalesce(sum(no_show), 0)::int AS "noShow",
             coalesce(sum(tasks_done), 0)::int AS "tasksDone", coalesce(sum(tasks_on_time), 0)::int AS "onTime",
             coalesce(sum(late_minutes_sum), 0)::float8 AS "lateMinutes",
             coalesce(sum(late_count), 0)::int AS "lateCount"
      FROM analytics_daily_event
      WHERE ${rollupWhere(q, days[0]!, days.at(-1)!, { pipelineNullable: true })} GROUP BY day`),
  ]);
  const num = (r: Record<string, number | string> | undefined, k: string) => Number(r?.[k] ?? 0);
  const cByDay = new Map(co.rows.map((r) => [String(r.day), r]));
  const eByDay = new Map(ev.rows.map((r) => [String(r.day), r]));
  const perDay = days.map((d) => {
    const c = cByDay.get(d);
    const e = eByDay.get(d);
    const cs: CohortSums = {
      arrived: num(c, "arrived"),
      contacted: num(c, "contacted"),
      replied: num(c, "replied"),
      won: num(c, "won"),
      within1h: num(c, "within1h"),
      within24h: num(c, "within24h"),
      hist: H.map((i) => num(c, `h${i}`)),
    };
    const es = Object.fromEntries(EVENT_KEYS.map((k) => [k, num(e, k)])) as EventSums;
    return valuesOf(cs, es, money);
  });
  const out: Partial<Record<SummedTile, (number | null)[]>> = {};
  for (const id of Object.keys(perDay[0] ?? {}) as SummedTile[]) out[id] = perDay.map((v) => v[id] ?? null);
  return out;
}

/** Speed to lead: a rollup's histogram estimate, or a live read's exact median. */
const speedOf = (c: { hist: number[] } | { speed: number | null }) =>
  "hist" in c ? quantileFromHist(c.hist, 0.5) : c.speed;

async function liveSeries(req: FastifyRequest, q: AnalyticsQuery, range: Range, tz: string) {
  const [now, before] = await Promise.all([
    liveDaily(req, spanOf(q, range), tz),
    liveDaily(req, spanOf(q, range.previous), tz),
  ]);
  const perDay = (rows: { day: string; n: number }[], days: string[]) => {
    const m = new Map(rows.map((r) => [r.day, r.n]));
    return days.map((d) => m.get(d) ?? 0);
  };
  return {
    days: range.days,
    newLeads: perDay(now.arrived, range.days),
    won: perDay(now.won, range.days),
    previous: {
      newLeads: perDay(before.arrived, range.previous.days),
      won: perDay(before.won, range.previous.days),
    },
    bySource: foldBySource(now.split, range.days),
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
  const [now, before, split] = await Promise.all([
    read(range.days),
    read(range.previous.days),
    // New leads per day by where they came from (canvas Main's bands): the four biggest sources, the rest together.
    req.db.execute<{ day: string; source_id: string | null; name: string | null; n: number }>(sql`
      SELECT to_char(c.day, 'YYYY-MM-DD') AS day, c.source_id, s.name, sum(c.arrived)::int AS n
      FROM analytics_daily_cohort c LEFT JOIN lead_sources s ON s.id = c.source_id
      WHERE ${rollupWhere(q, range.days[0]!, range.days.at(-1)!)}
      GROUP BY 1, 2, 3`),
  ]);
  return { days: range.days, ...now, previous: before, bySource: foldBySource(split.rows, range.days) };
}

/** New leads per day by where they came from (canvas Main's bands): the four biggest sources, the rest together. */
export function foldBySource(
  rows: { day: string; source_id: string | null; name: string | null; n: number }[],
  days: string[],
) {
  const split = { rows };
  const range = { days };
  const totals = new Map<string, { id: string | null; name: string; n: number }>();
  for (const r of split.rows) {
    const k = r.source_id ?? "none";
    const t = totals.get(k) ?? { id: r.source_id, name: r.name ?? "Added in LUME", n: 0 };
    t.n += r.n;
    totals.set(k, t);
  }
  // Ties by name, then id: the named bands and "N more sources" stay the same from load to load.
  const top = [...totals.values()].sort(
    (a, b) => b.n - a.n || a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)),
  );
  const at = new Map(split.rows.map((r) => [`${r.day}|${r.source_id ?? "none"}`, r.n]));
  const named = top.slice(0, top.length > 5 ? 4 : 5);
  const rest = top.slice(named.length);
  return [
    ...named.map((t) => ({
      id: t.id,
      name: t.name,
      values: range.days.map((d) => at.get(`${d}|${t.id ?? "none"}`) ?? 0),
    })),
    ...(rest.length
      ? [
          {
            id: "other",
            name: `${rest.length} more ${rest.length === 1 ? "source" : "sources"}`,
            values: range.days.map((d) =>
              rest.reduce((a, x) => a + (at.get(`${d}|${x.id ?? "none"}`) ?? 0), 0),
            ),
          },
        ]
      : []),
  ];
}
