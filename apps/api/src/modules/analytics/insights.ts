import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  DEFAULT_WORKING_HOURS,
  NOT_YET,
  hour12,
  noticed,
  type DetectorId,
  type InsightContext,
  type Seen,
} from "@lume/core";
import { ownerCond } from "./filters";
import { refuseLive } from "./live";
import { lost, sources, templates } from "./modules";
import { funnel } from "./funnel";
import { monthProgress } from "./month";
import { businessTz, eventSums, narrow, rangeOf, reachOf, seesRevenue, type AnalyticsQuery } from "./service";

/**
 * "LUME noticed" for one person (8B, spec §6): gathers each detector's numbers at the viewer's reach, runs the
 * detectors, holds back what this person saw in the last 14 days (unless it moved by half), and remembers what's
 * shown. Below about 200 leads nothing speaks; the card says what it's waiting for.
 */
export async function insights(req: FastifyRequest, q: AnalyticsQuery, now: Date) {
  refuseLive(q);
  const scope = reachOf(req, q.ownerIds);
  // Worded for the viewer's own reach before narrowing to their people's rows.
  const asked = q.ownerIds;
  q = narrow(req, q);
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  const total = (
    await req.db.execute<{ n: number }>(
      sql`SELECT coalesce(sum(arrived), 0)::int AS n FROM analytics_daily_cohort`,
    )
  ).rows[0]!.n;
  if (total < 200)
    return { ready: false as const, ...NOT_YET, progress: NOT_YET.progress(total), insights: [] };

  const money = seesRevenue(req);
  const currency =
    (await req.db.execute<{ c: string | null }>(sql`SELECT currency AS c FROM settings WHERE id = 1`)).rows[0]
      ?.c ?? null;
  const fmtMoney = (n: number) =>
    money
      ? new Intl.NumberFormat("en-US", {
          style: currency ? "currency" : "decimal",
          ...(currency ? { currency } : {}),
          maximumFractionDigits: 0,
        }).format(n)
      : null;

  const [src, lostBody, tpl, fun, ev, pev, speed, slots, people, overdueBy] = await Promise.all([
    sources(req, q, now),
    lost(req, { ...q, compare: true }, now),
    templates(req, q, now),
    funnel(req, { ...q, compare: true }, now),
    eventSums(req, q, range.days),
    eventSums(req, q, range.previous.days),
    // Speed pays: new leads 30 to 90 days old, contacted within the hour or later, and how many were won.
    req.db.execute<{
      fast_n: number;
      fast_won: number;
      slow_n: number;
      slow_won: number;
      median: number | null;
    }>(sql`
      SELECT count(*) FILTER (WHERE m < 60)::int AS fast_n, count(*) FILTER (WHERE m < 60 AND won)::int AS fast_won,
             count(*) FILTER (WHERE m >= 60)::int AS slow_n, count(*) FILTER (WHERE m >= 60 AND won)::int AS slow_won,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY m)::float8 AS median
      FROM (SELECT extract(epoch FROM f.first_contact_at - l.created_at) / 60 AS m, l.won_at IS NOT NULL AS won
            FROM leads l JOIN lead_firsts f ON f.lead_id = l.id AND f.first_contact_at IS NOT NULL
            WHERE l.deleted_at IS NULL AND l.created_at >= now() - interval '90 days' AND l.created_at < now() - interval '30 days'
              AND ${scope === "all" && !q.ownerIds?.length ? sql`true` : sql`lume_sees_credit(l.owner_id)`} AND ${ownerCond(q.ownerIds, sql`l.owner_id`) ?? sql`true`}) x`),
    req.db.execute<{ kind: string; dow: number; hour: number; n: number }>(sql`
      SELECT kind, dow, (hour / 2) * 2 AS hour, sum(n)::int AS n FROM analytics_daily_slot
      WHERE day BETWEEN ${range.days[0]!}::date AND ${range.days.at(-1)!}::date AND kind IN ('sends', 'replies')
        AND ${ownerCond(q.ownerIds, sql`user_id`) ?? sql`true`}
      GROUP BY 1, 2, 3`),
    // Each person's follow-ups due in the range: done, on time, and the late ones by weekday.
    req.db.execute<{
      id: string;
      name: string;
      done: number;
      on_time: number;
      dow: number | null;
      late: number;
    }>(sql`
      SELECT u.id, u.name, count(*) FILTER (WHERE t.status = 'done')::int AS done,
             count(*) FILTER (WHERE t.status = 'done' AND t.done_at <= t.due_at + interval '5 minutes')::int AS on_time,
             NULL::int AS dow, 0 AS late
      FROM tasks t JOIN users u ON u.id = t.assignee_id JOIN leads l ON l.id = t.lead_id AND l.deleted_at IS NULL
      WHERE t.due_at >= ${range.from.toISOString()}::timestamptz AND t.due_at < ${range.to.toISOString()}::timestamptz
        AND lume_sees_credit(t.assignee_id) AND ${ownerCond(q.ownerIds, sql`t.assignee_id`) ?? sql`true`}
      GROUP BY u.id, u.name
      UNION ALL
      SELECT u.id, u.name, 0, 0, extract(dow FROM t.due_at AT TIME ZONE ${tz})::int, count(*)::int
      FROM tasks t JOIN users u ON u.id = t.assignee_id JOIN leads l ON l.id = t.lead_id AND l.deleted_at IS NULL
      WHERE t.due_at >= ${range.from.toISOString()}::timestamptz AND t.due_at < ${range.to.toISOString()}::timestamptz
        AND t.status = 'done' AND t.done_at > t.due_at + interval '5 minutes'
        AND lume_sees_credit(t.assignee_id) AND ${ownerCond(q.ownerIds, sql`t.assignee_id`) ?? sql`true`}
      GROUP BY u.id, u.name, 5`),
    req.db.execute<{ name: string; n: number }>(sql`
      SELECT u.name, count(*)::int AS n FROM tasks t JOIN users u ON u.id = t.assignee_id
      JOIN leads l ON l.id = t.lead_id AND l.deleted_at IS NULL
      WHERE t.status = 'open' AND t.due_at < now() AND lume_sees_credit(t.assignee_id)
        AND ${ownerCond(q.ownerIds, sql`t.assignee_id`) ?? sql`true`}
      GROUP BY u.name`),
  ]);

  const byPerson = new Map<
    string,
    { id: string; name: string; done: number; onTime: number; lateByWeekday: number[] }
  >();
  for (const r of people.rows) {
    const p = byPerson.get(r.id) ?? {
      id: r.id,
      name: r.name,
      done: 0,
      onTime: 0,
      lateByWeekday: Array(7).fill(0),
    };
    p.done += r.done;
    p.onTime += r.on_time;
    if (r.dow !== null) p.lateByWeekday[r.dow] += r.late;
    byPerson.set(r.id, p);
  }
  const windows = new Map<string, { day: number; hour: number; sends: number; replies: number }>();
  for (const r of slots.rows) {
    const k = `${r.dow}:${r.hour}`;
    const w = windows.get(k) ?? { day: r.dow, hour: r.hour, sends: 0, replies: 0 };
    if (r.kind === "sends") w.sends += r.n;
    else w.replies += r.n;
    windows.set(k, w);
  }
  const s = speed.rows[0]!;
  const [goal, timeSlots, hours] = await Promise.all([
    // The business's goal for this month: revenue (with the money permission), else wins.
    req.db.execute<{ metric: "revenue" | "won"; target: string }>(sql`
      SELECT metric, target::text AS target FROM goals
      WHERE scope = 'business' AND period = 'month' AND period_start = ${monthProgress(now, tz).first}::date
        AND metric IN ('revenue', 'won')
      ORDER BY (metric = ${money ? "revenue" : "won"}) DESC LIMIT 1`),
    // Calls booked and missed, and arrivals, by weekday and hour in the range.
    req.db.execute<{ kind: string; dow: number; hour: number; n: number }>(sql`
      SELECT kind, dow, hour, sum(n)::int AS n FROM analytics_daily_slot
      WHERE day BETWEEN ${range.days[0]!}::date AND ${range.days.at(-1)!}::date
        AND kind IN ('booked', 'no_show', 'arrivals') AND ${ownerCond(q.ownerIds, sql`user_id`) ?? sql`true`}
      GROUP BY 1, 2, 3`),
    req.db.execute<{ wh: { days?: number[]; start?: string; end?: string } | null }>(
      sql`SELECT working_hours AS wh FROM settings WHERE id = 1`,
    ),
  ]);
  // The goal's pace, as goals count the month (8B): only money with the money permission.
  const g = goal.rows[0];
  const month = monthProgress(now, tz);
  const goalCtx: InsightContext["goal"] = g
    ? await (async () => {
        const col = g.metric === "revenue" ? sql`won_value` : sql`won`;
        const v = (
          await req.db.execute<{ v: number }>(sql`
            SELECT coalesce(sum(${col}), 0)::float8 AS v FROM analytics_daily_event
            WHERE day BETWEEN ${month.first}::date AND ${month.today}::date
              AND ${ownerCond(q.ownerIds, sql`user_id`) ?? sql`true`}`)
        ).rows[0]!.v;
        return {
          metricWords: g.metric === "revenue" ? "revenue" : "wins",
          month: month.name,
          value: v,
          target: Number(g.target),
          elapsed: month.elapsed,
          daysLeft: month.daysLeft,
          shown: (n: number) =>
            g.metric === "revenue" ? (fmtMoney(n) ?? String(Math.round(n))) : `${Math.round(n)} won`,
        };
      })()
    : undefined;
  // Calls by 2-hour window: booked and missed.
  const slotWindows = new Map<string, { day: number; hour: number; booked: number; noShow: number }>();
  for (const r of timeSlots.rows) {
    if (r.kind === "arrivals") continue;
    const w = { day: r.dow, hour: Math.floor(r.hour / 2) * 2 };
    const k = `${w.day}:${w.hour}`;
    const x = slotWindows.get(k) ?? { ...w, booked: 0, noShow: 0 };
    if (r.kind === "booked") x.booked += r.n;
    else x.noShow += r.n;
    slotWindows.set(k, x);
  }
  // Arrivals outside the business's working hours (days not worked count as after hours).
  const wh = { ...DEFAULT_WORKING_HOURS, ...(hours.rows[0]?.wh ?? {}) };
  const startH = Number(wh.start.slice(0, 2));
  const endH = Number(wh.end.slice(0, 2));
  const arrivalRows = timeSlots.rows.filter((r) => r.kind === "arrivals");
  const arrivalsTotal = arrivalRows.reduce((a, r) => a + r.n, 0);
  const afterHours = arrivalRows
    .filter((r) => !wh.days.includes(r.dow) || r.hour < startH || r.hour >= endH)
    .reduce((a, r) => a + r.n, 0);
  // "Contact them before … the next morning" only where speed has been shown to pay (speed_pays' own bar).
  const evidence =
    s.fast_n >= 30 &&
    s.slow_n >= 30 &&
    s.slow_won > 0 &&
    s.fast_won / s.fast_n >= 1.5 * (s.slow_won / s.slow_n);
  const ctx: InsightContext = {
    // Worded for one person when the numbers are one person's; several people read as a team.
    view: scope === "own" || asked?.length === 1 ? "own" : "team",
    money: fmtMoney,
    speed: {
      fastN: s.fast_n,
      fastWon: s.fast_won,
      slowN: s.slow_n,
      slowWon: s.slow_won,
      medianMinutes: s.median,
    },
    sources: src.sources.map((x) => ({
      id: x.id ?? "none",
      name: x.name,
      leads: x.leads,
      won: x.won,
      revenue: "revenue" in x ? (x.revenue as number) : 0,
      spend: "spend" in x ? (x.spend as number | null) : null,
    })),
    replyWindows: [...windows.values()],
    followups: {
      nowDone: ev.tasksDone,
      nowOnTime: ev.onTime,
      beforeDone: pev.tasksDone,
      beforeOnTime: pev.onTime,
      overdue: overdueBy.rows.reduce((a, r) => a + r.n, 0),
      overdueBy: overdueBy.rows,
    },
    people: [...byPerson.values()],
    stages: fun.stages.map((x) => ({
      id: x.id,
      name: x.name,
      reached: x.reached,
      stopped: x.stoppedN,
      prevReached: x.previousReached,
      prevStopped: x.previousStoppedN,
    })),
    lostReasons: lostBody.reasons.map((r) => ({
      id: r.id ?? "none",
      name: r.name,
      now: r.n,
      before: r.before,
    })),
    templates: tpl.templates.map((t) => ({ id: t.id, name: t.name, sends: t.sends, replies: t.replies })),
    wonBack: {
      n: lostBody.wonBack.n,
      value: "value" in lostBody.wonBack ? (lostBody.wonBack.value as number) : 0,
    },
    ...(goalCtx ? { goal: goalCtx } : {}),
    slots: [...slotWindows.values()],
    arrivals: {
      total: arrivalsTotal,
      afterHours,
      after: hour12(endH),
      contactBefore: hour12((startH + 1) % 24),
      evidence,
    },
  };

  const me = req.actor!.userId;
  const seen: Seen[] = (
    await req.db.execute<{ detector: DetectorId; subject: string; magnitude: string; shown_at: Date }>(sql`
      SELECT detector, subject, magnitude::text, shown_at FROM analytics_insight_seen WHERE user_id = ${me}::uuid`)
  ).rows.map((r) => ({
    detector: r.detector,
    subject: r.subject,
    magnitude: Number(r.magnitude),
    shownAt: new Date(r.shown_at),
  }));
  const shown = noticed(ctx, seen, now);
  for (const i of shown)
    await req.db.execute(sql`
      INSERT INTO analytics_insight_seen (user_id, detector, subject, magnitude, shown_at)
      VALUES (${me}::uuid, ${i.id}, ${i.subject}, ${i.magnitude}, ${now.toISOString()}::timestamptz)
      ON CONFLICT (user_id, detector, subject) DO UPDATE SET magnitude = EXCLUDED.magnitude, shown_at = EXCLUDED.shown_at`);
  return {
    ready: true as const,
    insights: shown.map((i) => ({
      id: i.id,
      subject: i.subject,
      title: i.title,
      body: i.body,
      magnitude: i.magnitude,
    })),
  };
}
