import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { dayOf, quantileFromHist, trend, type Range } from "@lume/core";
import type { AppDeps } from "../../app";
import { drillFor, frag } from "./drill";
import { isLive } from "./filters";
import { guardLive, spanOf } from "./live";
import { goalMonth } from "./month";
import {
  businessTz,
  liveLead,
  liveOwner,
  rangeOf,
  narrow,
  reachOf,
  rollupWhere,
  seesRevenue,
  type AnalyticsQuery,
} from "./service";

/**
 * Each person (canvas Team; 8D spec §4 Team): their numbers side by side, for a viewer who sees more than themselves;
 * where each stood the period before on every leaderboard metric (so a row can show its move); follow-up discipline;
 * and each person's goal for the month. Credit as everywhere: cohort numbers to the owner at arrival, wins to the
 * owner when won, calls to whoever held them, follow-ups to their assignee.
 */
const rate = (a: number, b: number) => (b > 0 ? a / b : null);
const H = Array.from({ length: 12 }, (_, i) => `coalesce(sum(speed_hist[${i + 1}]), 0)::int`).join(", ");

type Cohort = {
  user_id: string | null;
  arrived: number;
  contacted: number;
  replied: number;
  within1h: number;
  h: number[] | null;
  speed: number | null;
};
type Events = {
  user_id: string | null;
  won: number;
  won_value: number;
  done: number;
  on_time: number;
  held: number;
};
type Numbers = { cohort: Cohort[]; events: Events[] };

/** One span's per-person numbers: from the rollups, or live under a tag or field filter (the same definitions). */
async function perPerson(
  req: FastifyRequest,
  q: AnalyticsQuery,
  span: Range | Range["previous"],
): Promise<Numbers> {
  const [from, to] = [span.days[0]!, span.days.at(-1)!];
  if (!isLive(q)) {
    const [cohort, events] = await Promise.all([
      req.db.execute<Cohort>(sql`
        SELECT user_id, sum(arrived)::int AS arrived, sum(contacted)::int AS contacted, sum(replied)::int AS replied,
               sum(within_1h)::int AS "within1h", ARRAY[${sql.raw(H)}] AS h, NULL::float8 AS speed
        FROM analytics_daily_cohort WHERE ${rollupWhere(q, from, to)} GROUP BY user_id`),
      req.db.execute<Events>(sql`
        SELECT user_id, sum(won)::int AS won, sum(won_value)::float8 AS won_value, sum(tasks_done)::int AS done,
               sum(tasks_on_time)::int AS on_time, sum(held)::int AS held
        FROM analytics_daily_event WHERE ${rollupWhere(q, from, to, { pipelineNullable: true })} GROUP BY user_id`),
    ]);
    return { cohort: cohort.rows, events: events.rows };
  }
  const s = spanOf(q, span);
  const MINS = sql`CASE WHEN f.first_contact_at IS NULL THEN NULL
    ELSE greatest(0, extract(epoch FROM f.first_contact_at -
      CASE WHEN lume_owner_at(l.id, l.created_at, l.owner_id) IS NULL THEN coalesce(lume_first_assigned(l.id), l.created_at)
           ELSE l.created_at END) / 60) END`;
  const [cohort, won, tasks, held] = await Promise.all([
    req.db.execute<Cohort>(sql`
      SELECT x.user_id, count(*)::int AS arrived, count(*) FILTER (WHERE x.mins IS NOT NULL)::int AS contacted,
             count(*) FILTER (WHERE x.mins IS NOT NULL AND x.reply)::int AS replied,
             count(*) FILTER (WHERE x.mins < 60)::int AS "within1h", NULL::int[] AS h,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY x.mins)::float8 AS speed
      FROM (SELECT ${frag.COHORT_OWNER} AS user_id, ${MINS} AS mins, f.first_reply_at IS NOT NULL AS reply
            FROM leads l LEFT JOIN lead_firsts f ON f.lead_id = l.id
            WHERE ${frag.leads(s)} AND ${frag.cohort(s)}) x
      GROUP BY x.user_id`),
    req.db.execute<{ user_id: string | null; won: number; won_value: number }>(sql`
      SELECT lume_owner_at(l.id, l.won_at, l.owner_id) AS user_id, count(*)::int AS won,
             coalesce(sum(l.value), 0)::float8 AS won_value
      FROM leads l WHERE ${frag.leads(s)} AND ${frag.won(s)} GROUP BY 1`),
    req.db.execute<{ user_id: string; done: number; on_time: number }>(sql`
      SELECT t.assignee_id AS user_id, count(*) FILTER (WHERE t.status = 'done')::int AS done,
             count(*) FILTER (WHERE t.status = 'done' AND t.done_at <= t.due_at + interval '5 minutes')::int AS on_time
      FROM tasks t JOIN leads l ON l.id = t.lead_id
      WHERE ${frag.leads(s)} AND ${frag.span(s, sql`t.due_at`)} AND ${frag.credit(sql`t.assignee_id`, s.q)}
      GROUP BY 1`),
    req.db.execute<{ user_id: string; held: number }>(sql`
      SELECT m.owner_id AS user_id, count(*)::int AS held FROM meetings m JOIN leads l ON l.id = m.lead_id
      WHERE ${frag.leads(s)} AND ${frag.span(s, sql`m.starts_at`)} AND m.status = 'completed'
        AND ${frag.credit(sql`m.owner_id`, s.q)}
      GROUP BY 1`),
  ]);
  const ids = new Set([
    ...won.rows.map((r) => r.user_id),
    ...tasks.rows.map((r) => r.user_id),
    ...held.rows.map((r) => r.user_id),
  ]);
  return {
    cohort: cohort.rows,
    events: [...ids].map((id) => ({
      user_id: id,
      won: won.rows.find((r) => r.user_id === id)?.won ?? 0,
      won_value: won.rows.find((r) => r.user_id === id)?.won_value ?? 0,
      done: tasks.rows.find((r) => r.user_id === id)?.done ?? 0,
      on_time: tasks.rows.find((r) => r.user_id === id)?.on_time ?? 0,
      held: held.rows.find((r) => r.user_id === id)?.held ?? 0,
    })),
  };
}

type Metric = "won" | "revenue" | "speed" | "ontime" | "replies";
type Score = {
  id: string;
  won: number;
  revenue: number;
  speed: number | null;
  ontime: number | null;
  replies: number | null;
};
/** Where each person stands on one metric (1 = first); people with nothing to rank on aren't ranked. */
function ranks(rows: Score[], m: Metric, names: Map<string, string>): Map<string, number> {
  const value = (r: Score) => r[m];
  const ranked = rows
    .filter((r) => value(r) !== null)
    .sort((a, b) => {
      const va = value(a)!;
      const vb = value(b)!;
      // Speed: the quickest first; everything else: the most first.
      const d = m === "speed" ? va - vb : vb - va;
      return d || (names.get(a.id) ?? "").localeCompare(names.get(b.id) ?? "");
    });
  return new Map(ranked.map((r, i) => [r.id, i + 1]));
}

function scores(n: Numbers): Score[] {
  const ids = new Set<string>([
    ...n.cohort.flatMap((r) => (r.user_id ? [r.user_id] : [])),
    ...n.events.flatMap((r) => (r.user_id ? [r.user_id] : [])),
  ]);
  return [...ids].map((id) => {
    const c = n.cohort.find((r) => r.user_id === id);
    const e = n.events.find((r) => r.user_id === id);
    return {
      id,
      won: e?.won ?? 0,
      revenue: e?.won_value ?? 0,
      speed: c ? (c.h ? quantileFromHist(c.h, 0.5) : c.speed) : null,
      ontime: e ? rate(e.on_time, e.done) : null,
      replies: c ? rate(c.replied, c.contacted) : null,
    };
  });
}

export async function team(req: FastifyRequest, q: AnalyticsQuery, now: Date, d?: Pick<AppDeps, "keyring">) {
  const scope = reachOf(req, q.ownerIds);
  q = narrow(req, q);
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  guardLive(q, range);
  const money = seesRevenue(req);
  // Goals count their whole month (to today), whatever range is on screen.
  const gm = goalMonth(range.days.at(-1)!, dayOf(now, tz));
  const monthStart = gm.from;
  const sameAsMonth = range.days[0] === gm.from && range.days.at(-1) === gm.to;
  const [cur, prev, month, overdue, people, goals] = await Promise.all([
    perPerson(req, q, range),
    perPerson(req, q, range.previous),
    sameAsMonth ? null : perPerson(req, q, rangeOf({ ...q, range: "custom", ...gm }, tz, now)),
    req.db.execute<{ user_id: string; n: number }>(sql`
      SELECT t.assignee_id AS user_id, count(*)::int AS n FROM tasks t JOIN leads l ON l.id = t.lead_id
      WHERE t.status = 'open' AND t.due_at < now() AND ${liveLead(q)} AND ${liveOwner(q, sql`t.assignee_id`)}
      GROUP BY t.assignee_id`),
    req.db.execute<{ id: string; name: string; status: string }>(
      sql`SELECT id, name, status FROM users WHERE status <> 'invited'`,
    ),
    req.db.execute<{ scope_id: string; metric: "won" | "revenue"; target: string }>(sql`
      SELECT scope_id, metric, target::text AS target FROM goals
      WHERE scope = 'user' AND period = 'month' AND period_start = ${monthStart}::date AND metric IN ('won', 'revenue')`),
  ]);
  const names = new Map(people.rows.map((p) => [p.id, p.name]));
  const nowScores = scores(cur);
  const beforeScores = scores(prev);
  const metrics: Metric[] = [
    "won",
    ...(money ? (["revenue"] as Metric[]) : []),
    "speed",
    "ontime",
    "replies",
  ];
  const before = Object.fromEntries(metrics.map((m) => [m, ranks(beforeScores, m, names)])) as Record<
    Metric,
    Map<string, number>
  >;
  const prevOf = new Map(beforeScores.map((x) => [x.id, x]));
  const ids = new Set<string>([...nowScores.map((s) => s.id), ...overdue.rows.map((r) => r.user_id)]);
  const mint = (k: "person_cohort" | "person_won", userId: string) =>
    d ? drillFor(d, req, range, q, tz, k, { userId }, now) : undefined;
  const rows = [...ids].map((id) => {
    const c = cur.cohort.find((r) => r.user_id === id);
    const e = cur.events.find((r) => r.user_id === id);
    const s = nowScores.find((x) => x.id === id);
    // A won goal first; a revenue goal (with the money permission) otherwise.
    const g =
      goals.rows.find((x) => x.scope_id === id && x.metric === "won") ??
      (money ? goals.rows.find((x) => x.scope_id === id && x.metric === "revenue") : undefined);
    return {
      id,
      name: names.get(id) ?? "Someone",
      active: people.rows.find((p) => p.id === id)?.status === "active",
      newLeads: c?.arrived ?? 0,
      assigned: c?.arrived ?? 0,
      contacted: c ? rate(c.contacted, c.arrived) : null,
      within1h: c ? rate(c.within1h, c.contacted) : null,
      replyRate: c ? rate(c.replied, c.contacted) : null,
      speedToLead: s?.speed ?? null,
      held: e?.held ?? 0,
      won: e?.won ?? 0,
      ...(money ? { revenueWon: e?.won_value ?? 0 } : {}),
      ontime: e ? rate(e.on_time, e.done) : null,
      overdueNow: overdue.rows.find((r) => r.user_id === id)?.n ?? 0,
      previousRank: Object.fromEntries(metrics.map((m) => [m, before[m].get(id) ?? null])),
      // Each metric's value the period before (null: nothing then), for the leaderboard's change chips.
      previous: Object.fromEntries(
        metrics.map((m) => [m, prevOf.get(id)?.[m] ?? (m === "won" || m === "revenue" ? 0 : null)]),
      ),
      goal: g
        ? {
            metric: g.metric,
            target: Number(g.target),
            value: (() => {
              const me = (month ?? cur).events.find((r) => r.user_id === id);
              return g.metric === "won" ? (me?.won ?? 0) : (me?.won_value ?? 0);
            })(),
          }
        : null,
      drill: { cohort: mint("person_cohort", id), won: mint("person_won", id) },
    };
  });
  rows.sort((a, b) => b.won - a.won || b.newLeads - a.newLeads || a.name.localeCompare(b.name));
  const done = cur.events.reduce((a, e) => a + e.done, 0);
  const onTime = cur.events.reduce((a, e) => a + e.on_time, 0);
  const pDone = prev.events.reduce((a, e) => a + e.done, 0);
  const pOnTime = prev.events.reduce((a, e) => a + e.on_time, 0);
  const ontime = rate(onTime, done);
  const previousOntime = rate(pOnTime, pDone);
  return {
    range: { label: range.label, days: range.days },
    leaderboard: scope !== "own",
    people: rows,
    discipline: {
      ontime,
      previousOntime: q.compare ? previousOntime : null,
      trend:
        q.compare && ontime !== null && previousOntime !== null
          ? trend(ontime, previousOntime, { kind: "pts", good: "up" })
          : null,
      overdueNow: overdue.rows.reduce((a, r) => a + r.n, 0),
      people: rows.map((r) => ({ id: r.id, ontime: r.ontime, overdueNow: r.overdueNow })),
    },
  };
}
