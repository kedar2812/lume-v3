import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  businessTz,
  narrow,
  rangeOf,
  rate,
  rollupWhere,
  seesRevenue,
  tile,
  type AnalyticsQuery,
  type Tile,
} from "./service";

type Day = {
  day: string;
  arrived: number;
  contacted: number;
  replied: number;
  booked: number;
  revenue: number;
};

/**
 * Today's quick stats (frontend spec §8.2, today-prototype.html; owner 2026-10-05): four numbers at the viewer's
 * reach, each with its trend and a sparkline. New leads, reply rate and calls booked are the last 7 days against the
 * 7 before; revenue won is this month against the same days of last month, only with the money permission. The same
 * definitions and rollups as the Overview's tiles, read in one pass of a few hundred rows.
 */
export async function glance(req: FastifyRequest, now: Date) {
  const q = narrow(req, { range: "7d", compare: true } as AnalyticsQuery);
  const tz = await businessTz(req);
  const week = rangeOf(q, tz, now);
  const month = rangeOf({ ...q, range: "this_month" }, tz, now);
  const money = seesRevenue(req);
  const first = [week.previous.days[0]!, month.previous.days[0]!].sort()[0]!;
  const last = week.days.at(-1)!;
  const [cohort, events] = await Promise.all([
    req.db.execute<{ day: string; arrived: number; contacted: number; replied: number }>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(arrived)::int AS arrived, sum(contacted)::int AS contacted,
             sum(replied)::int AS replied
      FROM analytics_daily_cohort WHERE ${rollupWhere(q, first, last)} GROUP BY 1`),
    req.db.execute<{ day: string; booked: number; revenue: number }>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(booked)::int AS booked, coalesce(sum(won_value), 0)::float8 AS revenue
      FROM analytics_daily_event WHERE ${rollupWhere(q, first, last, { pipelineNullable: true })} GROUP BY 1`),
  ]);
  const byDay = new Map<string, Day>();
  const at = (day: string) => {
    let d = byDay.get(day);
    if (!d) byDay.set(day, (d = { day, arrived: 0, contacted: 0, replied: 0, booked: 0, revenue: 0 }));
    return d;
  };
  for (const r of cohort.rows)
    Object.assign(at(r.day), { arrived: r.arrived, contacted: r.contacted, replied: r.replied });
  for (const r of events.rows) Object.assign(at(r.day), { booked: r.booked, revenue: r.revenue });
  const days = (ds: string[]) => ds.map((d) => byDay.get(d) ?? at(d));
  const sum = (ds: Day[], k: keyof Omit<Day, "day">) => ds.reduce((a, d) => a + d[k], 0);
  const w = days(week.days);
  const pw = days(week.previous.days);
  const m = days(month.days);
  const pm = days(month.previous.days);
  // Revenue builds up through the month: its line climbs, as the canvas's does.
  let run = 0;
  const climbing = m.map((d) => (run += d.revenue));
  const kpis: (Tile & { series: number[]; period: "week" | "month" })[] = [
    {
      ...tile("new_leads", sum(w, "arrived"), sum(pw, "arrived"), true),
      series: w.map((d) => d.arrived),
      period: "week",
    },
    {
      ...tile(
        "reply_rate",
        rate(sum(w, "replied"), sum(w, "contacted")),
        rate(sum(pw, "replied"), sum(pw, "contacted")),
        true,
        {
          n: sum(w, "contacted"),
        },
      ),
      series: w.map((d) => rate(d.replied, d.contacted) ?? 0),
      period: "week",
    },
    {
      ...tile("calls_booked", sum(w, "booked"), sum(pw, "booked"), true),
      series: w.map((d) => d.booked),
      period: "week",
    },
    ...(money
      ? [
          {
            ...tile("revenue_won", sum(m, "revenue"), sum(pm, "revenue"), true),
            series: climbing,
            period: "month" as const,
          },
        ]
      : []),
  ];
  return {
    kpis,
    week: { from: week.days[0], to: week.days.at(-1) },
    month: { from: month.days[0], to: month.days.at(-1) },
  };
}
