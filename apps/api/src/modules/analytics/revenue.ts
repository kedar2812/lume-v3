import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { trend } from "@lume/core";
import type { AppDeps } from "../../app";
import { HttpError } from "../../http/errors";
import { drillFor, frag } from "./drill";
import { isLive } from "./filters";
import { guardLive, liveEvents, spanOf } from "./live";
import {
  businessTz,
  eventSums,
  rangeOf,
  narrow,
  rollupWhere,
  seesRevenue,
  type AnalyticsQuery,
} from "./service";

/**
 * Revenue (canvas Revenue; 8D spec §4): this month day by day against its goal, with the pace labelled as an
 * estimate; the last twelve months; and revenue won by package for the range. Money only, so only with
 * analytics.revenue.
 */
const rate = (a: number, b: number) => (b > 0 ? a / b : null);
const MONTH_WORDS = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

/** The business's month that holds `now`: its first day and every day to today. */
function monthToDate(now: Date, tz: string) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now); // YYYY-MM-DD
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const days = Array.from({ length: d }, (_, i) => `${today.slice(0, 8)}${String(i + 1).padStart(2, "0")}`);
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { today, first: `${today.slice(0, 8)}01`, days, inMonth, y, m };
}

export async function revenue(
  req: FastifyRequest,
  q: AnalyticsQuery,
  now: Date,
  d?: Pick<AppDeps, "keyring">,
) {
  // The board is money only: without the money permission it says so (the route's gate is analytics.view).
  if (!seesRevenue(req))
    throw new HttpError(403, "NO_REVENUE_ACCESS", "Revenue is only for people allowed to see it.");
  q = narrow(req, q);
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  guardLive(q, range);
  const live = isLive(q);
  const mint = (productId: string | null) =>
    d ? drillFor(d, req, range, q, tz, "product_won", { productId }, now) : undefined;
  const month = monthToDate(now, tz);
  const monthRange = rangeOf({ ...q, range: "custom", from: month.first, to: month.today }, tz, now);
  // Twelve months back from this one's first day (a year is the longest rollup read a request makes).
  const yearFrom = new Date(Date.UTC(month.y, month.m - 12, 1)).toISOString().slice(0, 10);

  const s = spanOf(q, range);
  const [thisMonthRows, byMonthRows, goals, products, now_, before] = await Promise.all([
    live
      ? req.db.execute<{ day: string; v: number }>(sql`
          SELECT to_char((l.won_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, coalesce(sum(l.value), 0)::float8 AS v
          FROM leads l WHERE ${frag.leads(spanOf(q, monthRange))} AND ${frag.won(spanOf(q, monthRange))} GROUP BY 1`)
      : req.db.execute<{ day: string; v: number }>(sql`
          SELECT to_char(day, 'YYYY-MM-DD') AS day, coalesce(sum(won_value), 0)::float8 AS v FROM analytics_daily_event
          WHERE ${rollupWhere(q, month.first, month.today, { pipelineNullable: true })} GROUP BY 1`),
    // By month reads a year of rollups; under a tag or field filter (92 days at most) it isn't offered.
    live
      ? Promise.resolve(null)
      : req.db.execute<{ month: string; v: number }>(sql`
          SELECT to_char(day, 'YYYY-MM') AS month, coalesce(sum(won_value), 0)::float8 AS v FROM analytics_daily_event
          WHERE ${rollupWhere(q, yearFrom, month.today, { pipelineNullable: true })} GROUP BY 1`),
    req.db.execute<{ start: string; target: string }>(sql`
      SELECT to_char(period_start, 'YYYY-MM-DD') AS start, target::text AS target FROM goals
      WHERE scope = 'business' AND metric = 'revenue' AND period = 'month'
        AND period_start BETWEEN ${yearFrom}::date AND ${month.first}::date`),
    // By package: the leads won in the range, each with its package (a live read of won leads only).
    req.db.execute<{ id: string | null; name: string | null; deals: number; v: number }>(sql`
      SELECT l.product_id AS id, p.name::text AS name, count(*)::int AS deals, coalesce(sum(l.value), 0)::float8 AS v
      FROM leads l LEFT JOIN products p ON p.id = l.product_id
      WHERE ${frag.leads(s)} AND ${frag.won(s)} GROUP BY 1, 2`),
    live ? liveEvents(req, s) : eventSums(req, q, range.days),
    live ? liveEvents(req, spanOf(q, range.previous)) : eventSums(req, q, range.previous.days),
  ]);

  const goalFor = (first: string) => {
    const g = goals.rows.find((x) => x.start === first);
    return g ? Number(g.target) : null;
  };
  const perDay = new Map(thisMonthRows.rows.map((r) => [r.day, r.v]));
  let running = 0;
  const cumulative = month.days.map((day) => (running += perDay.get(day) ?? 0));
  const elapsed = month.days.length / month.inMonth;
  // Before a fifth of the month has gone, a pace would mostly be noise.
  const paceEnd = elapsed >= 0.2 ? running / elapsed : null;

  const byMonth = byMonthRows
    ? Array.from({ length: 12 }, (_, i) => {
        const dt = new Date(Date.UTC(month.y, month.m - 12 + i, 1));
        const key = dt.toISOString().slice(0, 7);
        return {
          month: key,
          label: MONTH_WORDS.format(dt),
          value: byMonthRows.rows.find((r) => r.month === key)?.v ?? 0,
          goal: goalFor(`${key}-01`),
        };
      })
    : null;

  const total = now_.wonValue;
  const previousTotal = q.compare ? before.wonValue : null;
  const totalDeals = products.rows.reduce((a, p) => a + p.deals, 0);
  const totalValue = products.rows.reduce((a, p) => a + p.v, 0);
  const byProduct = products.rows
    .map((p) => ({
      id: p.id,
      name: p.id ? (p.name ?? "A removed package") : "Won without a package",
      deals: p.deals,
      value: p.v,
      share: rate(p.v, totalValue),
      drill: mint(p.id),
    }))
    .sort((a, b) => b.value - a.value || b.deals - a.deals);
  // A fact, not a suggestion (no test needed): the top package's share of deals beside its share of the money.
  const top = byProduct.find((p) => p.id);
  const fact =
    top && top.deals >= 10 && totalDeals && totalValue
      ? (() => {
          const dealShare = top.deals / totalDeals;
          const revenueShare = top.value / totalValue;
          return revenueShare >= dealShare + 0.1 ? { product: top.name, dealShare, revenueShare } : null;
        })()
      : null;

  return {
    range: { label: range.label, days: range.days },
    thisMonth: {
      days: month.days,
      cumulative,
      goal: goalFor(month.first),
      paceEnd,
      today: month.today,
      daysInMonth: month.inMonth,
    },
    byMonth,
    byProduct,
    fact,
    total,
    previousTotal,
    trend: previousTotal !== null ? trend(total, previousTotal, { kind: "pct", good: "up" }) : null,
    drill: d ? drillFor(d, req, range, q, tz, "revenue_won", undefined, now) : undefined,
  };
}
