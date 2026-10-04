import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { NOT_YET, noticed, type DetectorId, type InsightContext, type Seen } from "@lume/core";
import { ownerCond } from "./filters";
import { refuseLive } from "./live";
import { lost, sources, templates } from "./modules";
import { businessTz, eventSums, funnel, rangeOf, reachOf, seesRevenue, type AnalyticsQuery } from "./service";

/**
 * "LUME noticed" for one person (8B, spec §6): gathers each detector's numbers at the viewer's reach, runs the
 * detectors, holds back what this person saw in the last 14 days (unless it moved by half), and remembers what's
 * shown. Below about 200 leads nothing speaks; the card says what it's waiting for.
 */
export async function insights(req: FastifyRequest, q: AnalyticsQuery, now: Date) {
  refuseLive(q);
  const scope = reachOf(req, q.ownerIds);
  q = { ...q, reach: scope };
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
  const ctx: InsightContext = {
    // Worded for one person when the numbers are one person's; several people read as a team.
    view: scope === "own" || q.ownerIds?.length === 1 ? "own" : "team",
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
