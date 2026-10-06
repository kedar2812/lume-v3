import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { dayBounds, localDayBounds, scopeOf } from "@lume/core";
import {
  businessTz,
  eventSums,
  forecastNow,
  liveLead,
  liveOwner,
  narrow,
  rangeOf,
  seesRevenue,
  type AnalyticsQuery,
} from "../analytics/service";
import { glance } from "../analytics/glance";
import { listGoals } from "../analytics/goals";
import { templates } from "../analytics/modules";

/**
 * Today's tiles (spec 2026-10-05-today-control-centre-design.md). Each number answers one question, is counted
 * exactly as the same number is everywhere else in LUME, and is left out when the viewer may not see it — the
 * owner's rule: nothing on Today without a reason, nothing that isn't true.
 */
export async function tiles(req: FastifyRequest, now: Date) {
  const actor = req.actor!;
  const analytics = scopeOf(actor, "analytics.view");
  const leadsView = scopeOf(actor, "leads.view");
  const userTz = await viewerTz(req);
  const [leads, month, pipeline, calendar, team, streak, replies] = await Promise.all([
    leadsView ? leadsTile(req, now) : undefined,
    analytics ? monthTile(req, now) : undefined,
    leadsView ? pipelineTile(req, now) : undefined,
    calendarTile(req, now, userTz),
    analytics === "team" || analytics === "all" ? teamTile(req, now) : undefined,
    analytics === "team" || analytics === "all" ? undefined : streakTile(req, now, userTz),
    analytics ? repliesTile(req, now) : undefined,
  ]);
  return { leads, month, pipeline, calendar, team, streak, replies };
}

async function viewerTz(req: FastifyRequest): Promise<string> {
  const { rows } = await req.db.execute<{ tz: string }>(
    sql`SELECT coalesce(u.timezone, s.timezone, 'UTC') AS tz FROM settings s LEFT JOIN users u ON u.id = ${req.actor!.userId} WHERE s.id = 1`,
  );
  return rows[0]?.tz ?? "UTC";
}

const dayOf = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const addDays = (day: string, n: number) =>
  new Date(Date.parse(day + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Leads that arrived on a day, by the Analytics definition (rollups 0053): the enquiry date is that day, or there's
 * none and the lead entered LUME that day — in the business's time zone, at the viewer's leads.view reach (row-level
 * security). Two index reads (leads_enquiry_day, leads_arrived_undated), not a scan.
 */
function arrivals(day: string, t0: Date, t1: Date, before?: Date) {
  const cut = before ? sql`AND l.created_at < ${before.toISOString()}::timestamptz` : sql``;
  return sql`(
    SELECT l.id, l.created_at FROM leads l WHERE l.deleted_at IS NULL AND l.lead_created_at = ${day}::date ${cut}
    UNION ALL
    SELECT l.id, l.created_at FROM leads l WHERE l.deleted_at IS NULL AND l.lead_created_at IS NULL
      AND l.created_at >= ${t0.toISOString()}::timestamptz AND l.created_at < ${t1.toISOString()}::timestamptz ${cut})`;
}

/** Leads: are they coming in as usual today? Today's arrivals by hour, against this time last week and a usual day. */
export async function leadsTile(req: FastifyRequest, now: Date) {
  const tz = await businessTz(req);
  const today = dayOf(now, tz);
  const bounds = (day: string) => dayBounds(day, tz);
  const { start, end } = bounds(today);
  // The hour a lead entered LUME; one dated today but entered on another day goes in the first or last hour, so
  // the bars always add up to the number above them.
  const hourOf = sql`CASE WHEN a.created_at < ${start.toISOString()}::timestamptz THEN 0
    WHEN a.created_at >= ${end.toISOString()}::timestamptz THEN 23
    ELSE extract(hour FROM a.created_at AT TIME ZONE ${tz})::int END`;
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const lastDay = addDays(today, -7);
  const last = bounds(lastDay);
  const past = [1, 2, 3, 4].map((k) => addDays(today, -7 * k));
  const [hours, lastWeek, first, usualRows] = await Promise.all([
    req.db.execute<{ h: number; n: number; reached: number; mins: number[] | null }>(sql`
      SELECT ${hourOf} AS h, count(*)::int AS n, count(f.first_contact_at)::int AS reached,
             array_agg((extract(epoch FROM f.first_contact_at - a.created_at) / 60)::float8)
               FILTER (WHERE f.first_contact_at IS NOT NULL) AS mins
      FROM ${arrivals(today, start, end)} a LEFT JOIN lead_firsts f ON f.lead_id = a.id
      GROUP BY 1`),
    req.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${arrivals(lastDay, last.start, last.end, weekAgo)} a`,
    ),
    // When this viewer's leads began: a weekday before it isn't "usual", it's before LUME.
    req.db.execute<{ d: string | null }>(
      sql`SELECT to_char(min(day), 'YYYY-MM-DD') AS d FROM analytics_daily_cohort`,
    ),
    Promise.all(
      past.map(async (day) => {
        const b = bounds(day);
        const h = sql`CASE WHEN a.created_at < ${b.start.toISOString()}::timestamptz THEN 0
          WHEN a.created_at >= ${b.end.toISOString()}::timestamptz THEN 23
          ELSE extract(hour FROM a.created_at AT TIME ZONE ${tz})::int END`;
        const r = await req.db.execute<{ h: number; n: number }>(
          sql`SELECT ${h} AS h, count(*)::int AS n FROM ${arrivals(day, b.start, b.end)} a GROUP BY 1`,
        );
        return { day, rows: r.rows };
      }),
    ),
  ]);
  const byHour = Array<number>(24).fill(0);
  let reached = 0;
  const mins: number[] = [];
  for (const r of hours.rows) {
    byHour[r.h] = r.n;
    reached += r.reached;
    for (const m of r.mins ?? []) mins.push(Math.max(0, Number(m)));
  }
  const since = first.rows[0]?.d ?? null;
  const counted = usualRows.filter((w) => since !== null && w.day >= since);
  let usual: number[] | null = null;
  if (counted.length >= 2) {
    const sum = Array<number>(24).fill(0);
    for (const w of counted) for (const r of w.rows) sum[r.h] = (sum[r.h] ?? 0) + r.n;
    usual = sum.map((v) => Math.round((v / counted.length) * 10) / 10);
  }
  return {
    day: today,
    // The hour it is now on the business's clock: the bar still filling.
    hourNow: Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now),
    ),
    today: byHour.reduce((a, b) => a + b, 0),
    lastWeek: lastWeek.rows[0]!.n,
    hours: byHour,
    usual,
    weeks: counted.length,
    reached,
    // A median of fewer than three first contacts says nothing yet.
    medianMinutes: mins.length >= 3 ? Math.round(median(mins)!) : null,
  };
}

/** The month: what's been won so far against the same days of last month, and the goal it counts toward. */
export async function monthTile(req: FastifyRequest, now: Date) {
  const q = narrow(req, { range: "this_month", compare: true } as AnalyticsQuery);
  const tz = await businessTz(req);
  const r = rangeOf(q, tz, now);
  const money = seesRevenue(req);
  const [cur, prev, goals] = await Promise.all([
    eventSums(req, q, r.days),
    eventSums(req, q, r.previous.days),
    listGoals(req, r.days[0]!, "month", now),
  ]);
  const metric = money ? "revenue" : "won";
  const mine = goals.goals.filter((g) => g.metric === metric);
  const actor = req.actor!;
  // The goal for the very people the number counts: everyone's number, the business goal; one's own, one's own;
  // a team's, the goal of the team that is exactly those people (none when their reach spans more than one team).
  let goal: (typeof mine)[number] | undefined;
  if (q.reach === "all") goal = mine.find((g) => g.scope === "business");
  else if (q.reach === "own") goal = mine.find((g) => g.scope === "user" && g.scopeId === actor.userId);
  else {
    const teamGoals = mine.filter((g) => g.scope === "team");
    const people = new Set(q.ownerIds);
    if (teamGoals.length) {
      const { rows } = await req.db.execute<{ team_id: string; users: string[] }>(sql`
        SELECT team_id, array_agg(user_id::text) AS users FROM team_members
        WHERE team_id = ANY(${`{${teamGoals.map((g) => g.scopeId).join(",")}}`}::uuid[]) GROUP BY team_id`);
      goal = teamGoals.find((g) => {
        const users = rows.find((r) => r.team_id === g.scopeId)?.users ?? [];
        return users.length === people.size && users.every((u) => people.has(u));
      });
    }
  }
  return {
    money,
    from: r.days[0],
    to: r.days.at(-1),
    value: money ? cur.wonValue : cur.won,
    previous: money ? prev.wonValue : prev.won,
    won: cur.won,
    goal: goal
      ? {
          scope: goal.scope,
          target: goal.target,
          value: goal.value,
          elapsed: goal.elapsed,
          pace: goal.pace,
          daysLeft: goal.daysLeft,
        }
      : null,
  };
}

/** The pipeline right now: open leads in the default pipeline by stage, from the kept counts (exact at every moment). */
export async function pipelineTile(req: FastifyRequest, now: Date) {
  const { rows: pipes } = await req.db.execute<{ id: string; name: string; is_default: boolean }>(
    sql`SELECT id, name, is_default FROM pipelines WHERE archived_at IS NULL ORDER BY is_default DESC, position, created_at LIMIT 2`,
  );
  const p = pipes[0];
  if (!p) return undefined;
  const tz = await businessTz(req);
  const monthStart = dayBounds(dayOf(now, tz).slice(0, 8) + "01", tz).start;
  const [stages, counts, won, allOpen] = await Promise.all([
    req.db.execute<{ id: string; name: string; kind: string; prob: number | null }>(sql`
      SELECT id, name, kind, win_probability::float8 AS prob FROM stages
      WHERE pipeline_id = ${p.id}::uuid AND archived_at IS NULL ORDER BY position`),
    req.db.execute<{ stage_id: string; n: number }>(sql`
      SELECT stage_id, sum(n)::int AS n FROM lead_counts_now WHERE pipeline_id = ${p.id}::uuid GROUP BY stage_id`),
    req.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM leads l
      WHERE l.won_at >= ${monthStart.toISOString()}::timestamptz AND l.deleted_at IS NULL AND l.pipeline_id = ${p.id}::uuid`),
    pipes.length > 1
      ? req.db.execute<{ n: number }>(sql`
          SELECT coalesce(sum(c.n), 0)::int AS n FROM lead_counts_now c JOIN stages s ON s.id = c.stage_id WHERE s.kind = 'open'`)
      : Promise.resolve(null),
  ]);
  const n = new Map(counts.rows.map((r) => [r.stage_id, r.n]));
  const open = stages.rows.filter((s) => s.kind === "open");
  // A forecast needs the money permission, an analytics reach, and at least one stage with a win probability.
  const canForecast =
    seesRevenue(req) && !!scopeOf(req.actor!, "analytics.view") && open.some((s) => (s.prob ?? 0) > 0);
  const forecast = canForecast
    ? await forecastNow(req, narrow(req, { range: "7d", pipelineId: p.id } as AnalyticsQuery))
    : null;
  return {
    name: p.name,
    many: pipes.length > 1,
    open: open.reduce((a, s) => a + (n.get(s.id) ?? 0), 0),
    openEverywhere: allOpen ? allOpen.rows[0]!.n : null,
    stages: open.map((s) => ({ id: s.id, name: s.name, n: n.get(s.id) ?? 0 })),
    wonThisMonth: won.rows[0]!.n,
    forecast,
  };
}

/** Calls: the viewer's own, today and this week (from the business's first day of the week), in their time zone. */
export async function calendarTile(req: FastifyRequest, now: Date, tz: string) {
  const me = req.actor!.userId;
  const today = dayOf(now, tz);
  // The week starts on the business's own first day (Settings → Business; 0 is Sunday, 1 Monday).
  const ws = await req.db.execute<{ w: number }>(sql`SELECT week_start AS w FROM settings WHERE id = 1`);
  const dow = (new Date(today + "T12:00:00Z").getUTCDay() - (ws.rows[0]?.w ?? 1) + 7) % 7;
  const first = addDays(today, -dow);
  const from = dayBounds(first, tz).start;
  const to = dayBounds(addDays(first, 6), tz).end;
  const [week, connected] = await Promise.all([
    req.db.execute<{ d: string; n: number; held: number }>(sql`
      SELECT to_char(m.starts_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS d, count(*)::int AS n,
             count(*) FILTER (WHERE m.status = 'completed')::int AS held
      FROM meetings m
      WHERE m.owner_id = ${me}::uuid AND m.status NOT IN ('cancelled', 'rescheduled')
        AND m.starts_at >= ${from.toISOString()}::timestamptz AND m.starts_at < ${to.toISOString()}::timestamptz
      GROUP BY 1`),
    req.db.execute<{ yes: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM calendar_connections WHERE user_id = ${me}::uuid)
          OR EXISTS (SELECT 1 FROM lead_sources WHERE type = 'calendly' AND status <> 'archived') AS yes`),
  ]);
  const by = new Map(week.rows.map((r) => [r.d, r]));
  const days = Array.from({ length: 7 }, (_, i) => addDays(first, i));
  return {
    weekStart: first,
    todayIndex: dow,
    week: days.map((d) => by.get(d)?.n ?? 0),
    today: by.get(today)?.n ?? 0,
    held: by.get(today)?.held ?? 0,
    connected: connected.rows[0]!.yes,
  };
}

/** The team: whose follow-ups are overdue right now (the Overview's own number), and how often they're on time. */
export async function teamTile(req: FastifyRequest, now: Date) {
  const q = narrow(req, { range: "this_month" } as AnalyticsQuery);
  const tz = await businessTz(req);
  const r = rangeOf(q, tz, now);
  const [people, sums] = await Promise.all([
    req.db.execute<{ id: string; name: string; n: number }>(sql`
      SELECT t.assignee_id AS id, u.name, count(*)::int AS n
      FROM tasks t JOIN leads l ON l.id = t.lead_id JOIN users u ON u.id = t.assignee_id
      WHERE t.status = 'open' AND t.due_at < ${now.toISOString()}::timestamptz
        AND ${liveLead(q)} AND ${liveOwner(q, sql`t.assignee_id`)}
      GROUP BY 1, 2 ORDER BY n DESC, u.name`),
    eventSums(req, q, r.days),
  ]);
  return {
    overdue: people.rows.reduce((a, p) => a + p.n, 0),
    people: people.rows.slice(0, 3),
    // On time this month, the On time goal's definition; under ten done it says nothing yet.
    onTime: sums.tasksDone >= 10 ? sums.onTime / sums.tasksDone : null,
  };
}

/**
 * On time, day after day: back from yesterday, the days on which every follow-up due to the viewer that day was
 * done that same day (their time zone). Days with nothing due are skipped; today joins once it's all done.
 */
export async function streakTile(req: FastifyRequest, now: Date, tz: string) {
  const me = req.actor!.userId;
  const today = dayOf(now, tz);
  const from = dayBounds(addDays(today, -60), tz).start;
  const end = localDayBounds(now, tz).end;
  const { rows } = await req.db.execute<{ d: string; due: number; ok: number }>(sql`
    SELECT to_char(t.due_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS d, count(*)::int AS due,
           count(*) FILTER (WHERE t.status = 'done'
             AND to_char(t.done_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') <= to_char(t.due_at AT TIME ZONE ${tz}, 'YYYY-MM-DD'))::int AS ok
    FROM tasks t
    WHERE t.assignee_id = ${me}::uuid AND t.status IN ('open', 'done')
      AND t.due_at >= ${from.toISOString()}::timestamptz AND t.due_at < ${end.toISOString()}::timestamptz
    GROUP BY 1 ORDER BY 1 DESC`);
  const todayRow = rows.find((r) => r.d === today);
  const past = rows.filter((r) => r.d < today);
  let days = 0;
  for (const r of past) {
    if (r.ok < r.due) break;
    days++;
  }
  const todayDone = !!todayRow && todayRow.ok === todayRow.due;
  if (todayDone) days++;
  // The longest run in these 60 days, to say when today makes a new best.
  let best = 0;
  let run = 0;
  for (const r of [...rows].reverse()) {
    if (r.d === today && !todayDone) continue;
    run = r.ok >= r.due ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return {
    days,
    best,
    dueToday: todayRow?.due ?? 0,
    doneToday: todayRow?.ok ?? 0,
    // The last seven days that had something due, oldest first.
    last7: past
      .slice(0, 7)
      .reverse()
      .map((r) => (r.ok >= r.due ? "ok" : "missed")),
  };
}

/** Replies: the Overview's reply rate for the last 7 days and its days, and the template answered most often. */
export async function repliesTile(req: FastifyRequest, now: Date) {
  const [g, t] = await Promise.all([
    glance(req, now),
    templates(req, { range: "30d" } as AnalyticsQuery, now),
  ]);
  const k = g.kpis.find((x) => x.id === "reply_rate")!;
  const best = t.templates
    .filter((x) => !x.tooFew && x.replyRate !== null)
    .sort((a, b) => b.replyRate! - a.replyRate! || b.sends - a.sends)[0];
  return {
    rate: k.value,
    previous: k.previous,
    series: k.series,
    best: best ? { name: best.name, rate: best.replyRate!, sends: best.sends } : null,
  };
}
