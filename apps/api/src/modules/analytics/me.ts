import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { funnel } from "./funnel";
import { businessTz, overview, rangeOf, type AnalyticsQuery, type Tile } from "./service";

/**
 * A sales rep's own analytics (canvas Rep; 8D spec §4): their goals, their numbers, their follow-ups due now and
 * next, their funnel beside the business's win rate (one number that names nobody, shown only once the business has
 * 50 leads in the range), and the weekdays their leads reply. Always the viewer's own: owner and team are ignored.
 */
const OWN_TILES = [
  "new_leads",
  "contacted",
  "reply_rate",
  "speed_to_lead",
  "calls_held",
  "won",
  "win_rate",
  "ontime",
  "revenue_won",
] as const;
const MIN_BUSINESS = 50;
const MIN_SENDS = 10;
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
const GOAL_TILE = {
  won: "won",
  revenue: "revenue_won",
  calls_held: "calls_held",
  new_leads: "new_leads",
  ontime: "ontime",
} as const;
type GoalMetric = keyof typeof GOAL_TILE;

export async function me(req: FastifyRequest, q: AnalyticsQuery, now: Date, d?: Pick<AppDeps, "keyring">) {
  const id = req.actor!.userId;
  // Their own numbers, whatever was asked for: no one else's, and no team.
  const mine: AnalyticsQuery = { ...q, ownerIds: [id] };
  const tz = await businessTz(req);
  const range = rangeOf(mine, tz, now);
  const monthStart = `${range.days.at(-1)!.slice(0, 8)}01`;
  const [o, f, business, next, overdue, goals, slots] = await Promise.all([
    overview(req, mine, now),
    funnel(req, mine, now, d),
    req.db.execute<{ arrived: number; won: number }>(
      sql`SELECT arrived, won FROM lume_business_win_rate(${range.days[0]!}::date, ${range.days.at(-1)!}::date)`,
    ),
    req.db.execute<{
      id: string;
      lead_id: string;
      lead_name: string | null;
      title: string;
      due_at: Date;
    }>(sql`
      SELECT t.id, t.lead_id, l.name AS lead_name, t.title, t.due_at FROM tasks t JOIN leads l ON l.id = t.lead_id
      WHERE t.assignee_id = ${id}::uuid AND t.status = 'open' AND l.deleted_at IS NULL
      ORDER BY t.due_at, t.id LIMIT 5`),
    req.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM tasks t JOIN leads l ON l.id = t.lead_id
      WHERE t.assignee_id = ${id}::uuid AND t.status = 'open' AND t.due_at < now() AND l.deleted_at IS NULL`),
    req.db.execute<{ metric: GoalMetric; target: string }>(sql`
      SELECT metric, target::text AS target FROM goals
      WHERE scope = 'user' AND scope_id = ${id}::uuid AND period = 'month' AND period_start = ${monthStart}::date`),
    req.db.execute<{ kind: string; dow: number; n: number }>(sql`
      SELECT kind, dow, sum(n)::int AS n FROM analytics_daily_slot
      WHERE user_id = ${id}::uuid AND kind IN ('sends', 'replies')
        AND day BETWEEN ${range.days[0]!}::date AND ${range.days.at(-1)!}::date
      GROUP BY 1, 2`),
  ]);
  const tile = (tid: string) => o.tiles.find((t: Tile) => t.id === tid);
  const tiles = OWN_TILES.flatMap((t) => (tile(t) ? [tile(t)!] : []));
  const b = business.rows[0] ?? { arrived: 0, won: 0 };
  // How far through the goal's month we are: all of it once the month is over.
  const [y, m] = monthStart.split("-").map(Number) as [number, number];
  const monthFrom = Date.UTC(y, m - 1, 1);
  const monthTo = Date.UTC(y, m, 1);
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - monthFrom) / (monthTo - monthFrom)));
  const goalList = goals.rows.flatMap((g) => {
    const t = tile(GOAL_TILE[g.metric]);
    if (!t) return [];
    const value = t.value ?? 0;
    const target = Number(g.target);
    return [
      {
        metric: g.metric,
        target,
        value,
        // At this pace (an estimate): where the month ends, as a share of the goal. Rates (on time) don't pace.
        pace: g.metric === "ontime" || elapsed < 0.2 ? null : value / elapsed / target,
      },
    ];
  });
  const won = tile("won")?.value ?? 0;
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
    new Date(monthFrom),
  );
  const sends = (dow: number) => slots.rows.find((r) => r.kind === "sends" && r.dow === dow)?.n ?? 0;
  const replies = (dow: number) => slots.rows.find((r) => r.kind === "replies" && r.dow === dow)?.n ?? 0;
  return {
    range: o.range,
    heroLine: `Your ${month}${elapsed < 1 ? " so far" : ""}: ${won} won`,
    goals: goalList,
    tiles,
    followUps: {
      dueNow: overdue.rows[0]!.n,
      ontime: tile("ontime")?.value ?? null,
      next: next.rows.map((t) => ({
        id: t.id,
        leadId: t.lead_id,
        leadName: t.lead_name ?? "A lead",
        title: t.title,
        dueAt: new Date(t.due_at).toISOString(),
      })),
    },
    funnel: {
      stages: f.stages.map((s) => ({ id: s.id, name: s.name, share: s.share })),
      myWinRate: tile("win_rate")?.value ?? null,
      businessWinRate: b.arrived >= MIN_BUSINESS ? b.won / b.arrived : null,
    },
    replyDays: MONDAY_FIRST.map((dow) => ({
      dow,
      sends: sends(dow),
      rate: sends(dow) ? replies(dow) / sends(dow) : null,
      tooFew: sends(dow) < MIN_SENDS,
    })),
  };
}
