import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { quantileFromHist, trend, type Range } from "@lume/core";
import type { AppDeps } from "../../app";
import { drillFor, frag, type DrillExtra, type DrillKind } from "./drill";
import { LIVE_MAX_DAYS, isLive, ownerCond, sourceCond } from "./filters";
import { guardLive, liveCohort, liveEvents, liveStays, spanOf } from "./live";
import {
  TOO_FEW,
  businessTz,
  cohortSums,
  cycleDays,
  cycleHist,
  eventSums,
  liveLead,
  liveOwner,
  rangeOf,
  narrow,
  rollupWhere,
  seesRevenue,
  type AnalyticsQuery,
} from "./service";

/**
 * The funnel (canvas Funnel; 8A spec §4 `funnel`, 8D spec §4): for the leads that arrived in the range, the share
 * that reached each stage or a later one (open stages in order, then won), split by source or owner if asked; each
 * stage as it stands now; how long leads stay in each stage; what the pipeline earns a day; and the forecast by the
 * month LUME expects it.
 */
const rate = (a: number, b: number) => (b > 0 ? a / b : null);
/** Time in a stage needs a few stays before a median means anything. */
const TOO_FEW_STAYS = 5;
const STAY_H = Array.from({ length: 12 }, (_, i) => `coalesce(sum(a.stay_hist[${i + 1}]), 0)::int`).join(
  ", ",
);
const DAY_MS = 86_400_000;

type Stage = { id: string; name: string; kind: string; position: number };
type Split = "source" | "owner";

export async function funnel(
  req: FastifyRequest,
  q: AnalyticsQuery & { split?: Split },
  now: Date,
  d?: Pick<AppDeps, "keyring">,
) {
  q = narrow(req, q);
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  guardLive(q, range);
  const live = isLive(q);
  const pipeline =
    q.pipelineId ??
    (
      await req.db.execute<{ id: string }>(
        sql`SELECT id FROM pipelines WHERE archived_at IS NULL ORDER BY is_default DESC, position LIMIT 1`,
      )
    ).rows[0]?.id;
  if (!pipeline)
    return {
      range: { label: range.label, days: range.days },
      stages: [],
      arrived: 0,
      previousArrived: 0,
      now: { stages: [], openN: 0, openValue: null },
      timeInStage: [],
      velocity: null,
      forecast: null,
    };
  const scoped = { ...q, pipelineId: pipeline };
  const mint = (k: DrillKind, x?: DrillExtra) =>
    d ? drillFor(d, req, range, scoped, tz, k, x, now) : undefined;
  const all = (
    await req.db.execute<Stage>(sql`
      SELECT id, name, kind, position FROM stages WHERE pipeline_id = ${pipeline}::uuid AND archived_at IS NULL
      ORDER BY (kind = 'won'), (kind = 'lost'), position`)
  ).rows;
  const stages = all.filter((s) => s.kind !== "lost");
  const openStages = stages.filter((s) => s.kind === "open");
  const money = seesRevenue(req);

  const reachRead = (span: { from: Date; to: Date; days: string[] }) =>
    live ? reachLive(req, scoped, span, pipeline) : reachRollup(req, scoped, span.days);
  const arrivedRead = async (span: { from: Date; to: Date; days: string[] }) =>
    live
      ? (await liveCohort(req, spanOf(scoped, span))).arrived
      : (await cohortSums(req, scoped, span.days)).arrived;
  // Time in stage's rollup carries no source, tag or field: under one it reads the stage history, for up to 92 days
  // (a tag or field already bounds the board); a source over a longer range says so instead of counting every source.
  const staysLive = live || !!q.sourceIds?.length;
  const staysNote =
    staysLive && range.days.length > LIVE_MAX_DAYS
      ? "Time in stage can be narrowed by source for up to 92 days. Pick a shorter range to see it."
      : null;
  const [cur, prev, arrived, prevArrived, split, snapshot, stays, velocity, forecast] = await Promise.all([
    reachRead(range),
    reachRead(range.previous),
    arrivedRead(range),
    arrivedRead(range.previous),
    q.split ? splitBy(req, scoped, range, pipeline, q.split, stages, live) : Promise.resolve(undefined),
    stageSnapshot(req, scoped, openStages, money, live),
    staysNote ? Promise.resolve([]) : stageStays(req, scoped, range, openStages, live, staysLive),
    money ? pipelineVelocity(req, scoped, range, tz, pipeline, live) : Promise.resolve(null),
    money ? forecastByMonth(req, scoped, tz, pipeline, openStages, now, live) : Promise.resolve(null),
  ]);
  const orLater = (m: Map<string, number>, i: number) =>
    stages.slice(i).reduce((a, s) => a + (m.get(s.id) ?? 0), 0);
  return {
    range: { label: range.label, days: range.days },
    arrived,
    previousArrived: prevArrived,
    stages: stages.map((s, i) => {
      const reached = orLater(cur, i);
      const before = orLater(prev, i);
      const share = rate(reached, arrived);
      const prevShare = rate(before, prevArrived);
      return {
        id: s.id,
        name: s.name,
        kind: s.kind,
        reached,
        share,
        // Of those that reached this stage, the share that went no further (it's their furthest).
        stopped: reached ? (cur.get(s.id) ?? 0) / reached : null,
        stoppedN: cur.get(s.id) ?? 0,
        previousReached: before,
        previousStoppedN: prev.get(s.id) ?? 0,
        tooFew: reached < TOO_FEW,
        trend:
          q.compare && share !== null && prevShare !== null
            ? trend(share, prevShare, { kind: "pts", good: "up" })
            : null,
        drill: {
          reached: mint("funnel_reached", { stageId: s.id }),
          stopped: mint("funnel_stopped", { stageId: s.id }),
        },
      };
    }),
    ...(split ? { split } : {}),
    now: {
      stages: snapshot.map((s) => ({ ...s, drill: mint("stage_now", { stageId: s.id }) })),
      openN: snapshot.reduce((a, s) => a + s.n, 0),
      openValue: money ? snapshot.reduce((a, s) => a + (s.value ?? 0), 0) : null,
    },
    timeInStage: stays.map((s) => ({ ...s, drill: { stuck: mint("stuck", { stageId: s.id }) } })),
    ...(staysNote ? { timeInStageNote: staysNote } : {}),
    velocity,
    forecast,
  };
}

/** Each cohort lead's furthest stage, from the rollups (0053's analytics_daily_reach). */
async function reachRollup(req: FastifyRequest, q: AnalyticsQuery, days: string[]) {
  const r = await req.db.execute<{ stage_id: string; n: number }>(sql`
    SELECT stage_id, sum(n)::int AS n FROM analytics_daily_reach WHERE ${rollupWhere(q, days[0]!, days.at(-1)!)}
    GROUP BY stage_id`);
  return new Map(r.rows.map((x) => [x.stage_id, x.n]));
}

/** The same, read live (a tag or field filter): the furthest stage by lume_furthest_stage (0056), the same rule. */
async function reachLive(
  req: FastifyRequest,
  q: AnalyticsQuery,
  span: { from: Date; to: Date; days: string[] },
  pipeline: string,
) {
  const s = spanOf(q, span);
  const r = await req.db.execute<{ stage_id: string; n: number }>(sql`
    SELECT x.stage_id, count(*)::int AS n
    FROM (SELECT lume_furthest_stage(l.id, ${pipeline}::uuid) AS stage_id FROM leads l
          WHERE ${frag.leads(s)} AND ${frag.cohort(s)}) x
    WHERE x.stage_id IS NOT NULL GROUP BY x.stage_id`);
  return new Map(r.rows.map((x) => [x.stage_id, x.n]));
}

/** Each source's (or owner's) own funnel: the five biggest by arrivals, the rest together. */
async function splitBy(
  req: FastifyRequest,
  q: AnalyticsQuery,
  range: Range,
  pipeline: string,
  by: Split,
  stages: Stage[],
  live: boolean,
) {
  let reachRows: { g: string | null; stage_id: string; n: number }[];
  let arrivedRows: { g: string | null; n: number }[];
  if (live) {
    const s = spanOf(q, range);
    const group = by === "source" ? sql`l.source_id` : frag.COHORT_OWNER;
    const r = await req.db.execute<{ g: string | null; stage_id: string | null; n: number }>(sql`
      SELECT x.g, x.stage_id, count(*)::int AS n
      FROM (SELECT ${group} AS g, lume_furthest_stage(l.id, ${pipeline}::uuid) AS stage_id FROM leads l
            WHERE ${frag.leads(s)} AND ${frag.cohort(s)}) x
      GROUP BY 1, 2`);
    reachRows = r.rows.flatMap((x) => (x.stage_id ? [{ g: x.g, stage_id: x.stage_id, n: x.n }] : []));
    const totals = new Map<string | null, number>();
    for (const x of r.rows) totals.set(x.g, (totals.get(x.g) ?? 0) + x.n);
    arrivedRows = [...totals].map(([g, n]) => ({ g, n }));
  } else {
    const col = sql.raw(by === "source" ? "source_id" : "user_id");
    const [reach, arrived] = await Promise.all([
      req.db.execute<{ g: string | null; stage_id: string; n: number }>(sql`
        SELECT ${col} AS g, stage_id, sum(n)::int AS n FROM analytics_daily_reach
        WHERE ${rollupWhere(q, range.days[0]!, range.days.at(-1)!)} GROUP BY 1, 2`),
      req.db.execute<{ g: string | null; n: number }>(sql`
        SELECT ${col} AS g, sum(arrived)::int AS n FROM analytics_daily_cohort
        WHERE ${rollupWhere(q, range.days[0]!, range.days.at(-1)!)} GROUP BY 1`),
    ]);
    reachRows = reach.rows;
    arrivedRows = arrived.rows;
  }
  const names = new Map(
    (by === "source"
      ? await req.db.execute<{ id: string; name: string }>(sql`SELECT id, name FROM lead_sources`)
      : await req.db.execute<{ id: string; name: string }>(sql`SELECT id, name FROM users`)
    ).rows.map((x) => [x.id, x.name]),
  );
  const ordered = [...arrivedRows].sort((a, b) => b.n - a.n);
  const top = ordered.slice(0, ordered.length > 6 ? 5 : 6);
  const rest = new Set(ordered.slice(top.length).map((x) => x.g));
  const group = (keys: (string | null)[], id: string | null, name: string) => {
    const arrived = arrivedRows.filter((x) => keys.includes(x.g)).reduce((a, x) => a + x.n, 0);
    const m = new Map<string, number>();
    for (const x of reachRows) if (keys.includes(x.g)) m.set(x.stage_id, (m.get(x.stage_id) ?? 0) + x.n);
    return {
      id,
      name,
      arrived,
      stages: stages.map((s, i) => {
        const reached = stages.slice(i).reduce((a, t) => a + (m.get(t.id) ?? 0), 0);
        return { id: s.id, reached, share: rate(reached, arrived) };
      }),
    };
  };
  const nobody = by === "source" ? "Added in LUME" : "Nobody yet";
  return {
    by,
    groups: [
      ...top.map((t) => group([t.g], t.g, t.g ? (names.get(t.g) ?? "Someone") : nobody)),
      ...(rest.size ? [group([...rest], "other", by === "source" ? "Other sources" : "Everyone else")] : []),
    ],
  };
}

/** Each open stage as it stands now, whatever the range: how many leads, what they're worth, how long they've sat. */
async function stageSnapshot(
  req: FastifyRequest,
  q: AnalyticsQuery,
  openStages: Stage[],
  money: boolean,
  live: boolean,
) {
  const ids = `{${openStages.map((s) => s.id).join(",")}}`;
  // Counts and value from the kept counts (0048) unless a filter they don't carry needs each lead.
  const fast = !live && !q.sourceIds?.length;
  // Average age from the "now" snapshot (0059), counted every 10 minutes; live under a tag or field filter.
  const nowWhere = sql`stage_id = ANY(${ids}::uuid[]) AND ${ownerCond(q.ownerIds, sql`owner_id`) ?? sql`true`}
    AND ${sourceCond(q.sourceIds, sql`source_id`) ?? sql`true`}`;
  const [counts, ages] = await Promise.all([
    fast
      ? req.db.execute<{ stage_id: string; n: number; value: number }>(sql`
          SELECT c.stage_id, sum(c.n)::int AS n, coalesce(sum(c.value), 0)::float8 AS value FROM lead_counts_now c
          WHERE c.stage_id = ANY(${ids}::uuid[]) AND ${liveOwner(q, sql`c.owner_id`)} GROUP BY c.stage_id`)
      : live
        ? req.db.execute<{ stage_id: string; n: number; value: number }>(sql`
            SELECT l.stage_id, count(*)::int AS n, coalesce(sum(l.value), 0)::float8 AS value FROM leads l
            WHERE l.stage_id = ANY(${ids}::uuid[]) AND ${liveLead(q)} AND ${liveOwner(q, sql`l.owner_id`)} GROUP BY l.stage_id`)
        : req.db.execute<{ stage_id: string; n: number; value: number }>(sql`
            SELECT stage_id, sum(n)::int AS n, coalesce(sum(value), 0)::float8 AS value FROM analytics_open_now
            WHERE ${nowWhere} GROUP BY stage_id`),
    live
      ? req.db.execute<{ stage_id: string; days: number | null }>(sql`
          SELECT l.stage_id, avg(extract(epoch FROM now() - l.stage_entered_at) / 86400)::float8 AS days FROM leads l
          WHERE l.stage_id = ANY(${ids}::uuid[]) AND ${liveLead(q)} AND ${liveOwner(q, sql`l.owner_id`)} GROUP BY l.stage_id`)
      : req.db.execute<{ stage_id: string; days: number | null }>(sql`
          SELECT stage_id, (extract(epoch FROM now()) - sum(entered_sum) / nullif(sum(n), 0))::float8 / 86400 AS days
          FROM analytics_open_now WHERE ${nowWhere} GROUP BY stage_id`),
  ]);
  return openStages.map((s) => {
    const c = counts.rows.find((x) => x.stage_id === s.id);
    return {
      id: s.id,
      name: s.name,
      n: c?.n ?? 0,
      ...(money ? { value: c ? c.value : 0 } : {}),
      avgAgeDays: ages.rows.find((x) => x.stage_id === s.id)?.days ?? null,
    };
  });
}

/** How long leads stayed in each open stage (stays that ended in the range), its allowed time, and who's stuck now. */
async function stageStays(
  req: FastifyRequest,
  q: AnalyticsQuery,
  range: Range,
  openStages: Stage[],
  live: boolean,
  staysLive: boolean,
) {
  const ids = `{${openStages.map((s) => s.id).join(",")}}`;
  const own = ownerCond(q.ownerIds, sql`a.user_id`);
  const [stays, stuck, sla] = await Promise.all([
    staysLive
      ? liveStays(req, q, range)
      : req.db.execute<{ stage_id: string; exited: number; h: number[] }>(sql`
          SELECT a.stage_id, sum(a.exited)::int AS exited, ARRAY[${sql.raw(STAY_H)}] AS h
          FROM analytics_daily_stage a
          WHERE a.day BETWEEN ${range.days[0]!}::date AND ${range.days.at(-1)!}::date AND a.stage_id = ANY(${ids}::uuid[])
            ${own ? sql`AND ${own}` : sql``}
          GROUP BY a.stage_id`),
    live
      ? req.db.execute<{ stage_id: string; n: number }>(sql`
          SELECT l.stage_id, count(*)::int AS n FROM leads l JOIN stages s ON s.id = l.stage_id
          WHERE l.stage_id = ANY(${ids}::uuid[]) AND ${liveLead(q)} AND s.sla_hours IS NOT NULL
            AND l.stage_entered_at < now() - make_interval(hours => s.sla_hours) AND ${liveOwner(q, sql`l.owner_id`)}
          GROUP BY l.stage_id`)
      : req.db.execute<{ stage_id: string; n: number }>(sql`
          SELECT stage_id, sum(stuck)::int AS n FROM analytics_open_now
          WHERE stage_id = ANY(${ids}::uuid[]) AND ${ownerCond(q.ownerIds, sql`owner_id`) ?? sql`true`}
            AND ${sourceCond(q.sourceIds, sql`source_id`) ?? sql`true`}
          GROUP BY stage_id`),
    req.db.execute<{ id: string; sla_hours: number | null }>(sql`
      SELECT id, sla_hours FROM stages WHERE id = ANY(${ids}::uuid[])`),
  ]);
  return openStages.map((s) => {
    const st = stays.rows.find((x) => x.stage_id === s.id);
    const exited = st?.exited ?? 0;
    return {
      id: s.id,
      name: s.name,
      exited,
      medianMinutes: st && exited ? quantileFromHist(st.h, 0.5) : null,
      p75Minutes: st && exited ? quantileFromHist(st.h, 0.75) : null,
      slaHours: sla.rows.find((x) => x.id === s.id)?.sla_hours ?? null,
      stuckNow: stuck.rows.find((x) => x.stage_id === s.id)?.n ?? 0,
      tooFew: exited < TOO_FEW_STAYS,
    };
  });
}

/** The 90 days ending on `last` (a business day), as a span. */
function ninetyDays(q: AnalyticsQuery, tz: string, last: string, now: Date) {
  const to = new Date(`${last}T00:00:00Z`);
  const from = new Date(to.getTime() - 89 * DAY_MS).toISOString().slice(0, 10);
  return rangeOf({ ...q, range: "custom", from, to: last }, tz, now);
}

/**
 * Pipeline velocity (8A spec §4 `velocity`): open leads × win rate × average deal ÷ median days to win, each over the
 * 90 days to the range's end; and the same over the 90 days to the previous range's end.
 */
async function pipelineVelocity(
  req: FastifyRequest,
  q: AnalyticsQuery,
  range: Range,
  tz: string,
  pipeline: string,
  live: boolean,
) {
  const parts = async (last: string) => {
    const span = ninetyDays(q, tz, last, range.to);
    const e = live ? await liveEvents(req, spanOf(q, span)) : await eventSums(req, q, span.days);
    const cyc = await cycleDays(req, q, span.from, span.to, tz);
    const winRate = rate(e.won, e.won + e.lost);
    const valued = e.won - e.wonNoValue;
    const avgDeal = valued ? e.wonValue / valued : null;
    return { winRate, avgDeal, cycleDays: cyc };
  };
  const [openLeads, nowParts, beforeParts, hist] = await Promise.all([
    live
      ? req.db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM leads l JOIN stages s ON s.id = l.stage_id AND s.kind = 'open'
          WHERE l.pipeline_id = ${pipeline}::uuid AND ${liveLead(q)} AND ${liveOwner(q, sql`l.owner_id`)}`)
      : req.db.execute<{ n: number }>(sql`
          SELECT coalesce(sum(n), 0)::int AS n FROM analytics_open_now WHERE pipeline_id = ${pipeline}::uuid
            AND ${ownerCond(q.ownerIds, sql`owner_id`) ?? sql`true`} AND ${sourceCond(q.sourceIds, sql`source_id`) ?? sql`true`}`),
    parts(range.days.at(-1)!),
    parts(range.previous.days.at(-1)!),
    // How long its wins took, drawn under the sum (canvas Funnel: "How long a win takes").
    (() => {
      const span = ninetyDays(q, tz, range.days.at(-1)!, range.to);
      return cycleHist(req, q, span.from, span.to, tz);
    })(),
  ]);
  const n = openLeads.rows[0]!.n;
  const per = (p: { winRate: number | null; avgDeal: number | null; cycleDays: number | null }) =>
    p.winRate !== null && p.avgDeal !== null && p.cycleDays
      ? (n * p.winRate * p.avgDeal) / p.cycleDays
      : null;
  const perDay = per(nowParts);
  const previousPerDay = per(beforeParts);
  return {
    openLeads: n,
    ...nowParts,
    perDay,
    previousPerDay,
    cycleHist: hist,
    trend:
      q.compare && perDay !== null && previousPerDay !== null
        ? trend(perDay, previousPerDay, { kind: "pct", good: "up" })
        : null,
  };
}

/**
 * The forecast by the month LUME expects each open lead to be won (8A spec §4.2): its stage's median days from
 * entering to winning (wins of the last 180 days), or with fewer than 10 such wins the median days to win minus the
 * median days spent before the stage; never earlier than today. Each lead counts its value × its stage's chance.
 */
async function forecastByMonth(
  req: FastifyRequest,
  q: AnalyticsQuery,
  tz: string,
  pipeline: string,
  openStages: Stage[],
  now: Date,
  live: boolean,
) {
  const byPosition = [...openStages].sort((a, b) => b.position - a.position);
  const latest = byPosition[0];
  const second = byPosition[1];
  // Kept with the "now" snapshot (0059) by the same rule; read live only under a tag or field filter.
  const r = live
    ? await forecastLive(req, q, tz, pipeline)
    : await req.db.execute<{ month: string; stage_id: string; v: number }>(sql`
        SELECT month, stage_id, sum(v)::float8 AS v FROM analytics_forecast_now
        WHERE pipeline_id = ${pipeline}::uuid AND ${ownerCond(q.ownerIds, sql`owner_id`) ?? sql`true`}
          AND ${sourceCond(q.sourceIds, sql`source_id`) ?? sql`true`}
        GROUP BY 1, 2`);
  return foldForecast(r.rows, tz, now, latest, second);
}

async function forecastLive(req: FastifyRequest, q: AnalyticsQuery, tz: string, pipeline: string) {
  return req.db.execute<{ month: string; stage_id: string; v: number }>(sql`
    WITH wins AS (
      SELECT l.id, l.created_at, l.won_at FROM leads l
      WHERE l.pipeline_id = ${pipeline}::uuid AND l.deleted_at IS NULL AND l.won_at >= now() - interval '180 days'
    ), entries AS (
      SELECT h.to_stage_id AS stage_id, extract(epoch FROM w.won_at - h.changed_at) / 86400 AS to_win,
             extract(epoch FROM h.changed_at - w.created_at) / 86400 AS before
      FROM wins w JOIN lead_stage_history h ON h.lead_id = w.id AND h.changed_at <= w.won_at
    ), cycle AS (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM won_at - created_at) / 86400) AS m FROM wins
    ), med AS (
      SELECT e.stage_id,
             CASE WHEN count(*) >= 10 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY e.to_win)
                  ELSE greatest(0, (SELECT m FROM cycle) - percentile_cont(0.5) WITHIN GROUP (ORDER BY e.before)) END AS days
      FROM entries e GROUP BY e.stage_id
    )
    SELECT to_char(greatest(l.stage_entered_at + make_interval(secs => coalesce(med.days, 0) * 86400), now())
                   AT TIME ZONE ${tz}, 'YYYY-MM') AS month,
           l.stage_id, sum(l.value * coalesce(s.win_probability, 0) / 100)::float8 AS v
    FROM leads l JOIN stages s ON s.id = l.stage_id AND s.kind = 'open'
    LEFT JOIN med ON med.stage_id = l.stage_id
    WHERE l.pipeline_id = ${pipeline}::uuid AND l.value IS NOT NULL AND ${liveLead(q)} AND ${liveOwner(q, sql`l.owner_id`)}
    GROUP BY 1, 2`);
}

function foldForecast(
  rows: { month: string; stage_id: string; v: number }[],
  tz: string,
  now: Date,
  latest: Stage | undefined,
  second: Stage | undefined,
) {
  const first = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" })
    .format(now)
    .slice(0, 7);
  const months = [0, 1, 2].map((i) => {
    const [y, m] = first.split("-").map(Number) as [number, number];
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return {
      month: d.toISOString().slice(0, 7),
      label: new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(d),
      latest: 0,
      second: 0,
      earlier: 0,
    };
  });
  let later = 0;
  for (const row of rows) {
    // Counted before this month began (the snapshot is up to 10 minutes old): it's due now, so this month.
    const bucket = row.month < months[0]!.month ? months[0] : months.find((m) => m.month === row.month);
    if (!bucket) {
      later += row.v;
      continue;
    }
    if (latest && row.stage_id === latest.id) bucket.latest += row.v;
    else if (second && row.stage_id === second.id) bucket.second += row.v;
    else bucket.earlier += row.v;
  }
  return {
    months,
    later,
    stageNames: [latest?.name ?? "", second?.name ?? ""] as [string, string],
  };
}
