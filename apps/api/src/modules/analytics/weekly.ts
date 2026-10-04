import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { METRICS, mergePreferences, scopeOf, type MetricId } from "@lume/core";
import { schema } from "@lume/db";
import { applyRequestScope } from "../../db/context";
import { weeklyAnalyticsMail } from "../../mail/templates";
import type { Mailer } from "../../mail/mailer";
import { loadActor } from "../../rbac/actor";
import { insights } from "./insights";
import { funnel, overview, team, type AnalyticsQuery } from "./service";

export type WeeklyDeps = {
  pool: pg.Pool;
  mailer: Mailer;
  publicUrl: string;
  log?: { error: (o: object, msg?: string) => void };
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function wall(now: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      weekday: "short",
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: DAYS.indexOf(p.weekday!), hour: Number(p.hour) };
}
const shift = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * The Monday email (8B, spec §5.3): at 09:00 business time, to everyone active who sees all analytics and hasn't
 * switched it off, last week (Monday to Sunday) against the week before. Each person's numbers are read as them
 * (their own reach and money permission). One per person per week, claimed before it's sent.
 */
export async function runWeekly(d: WeeklyDeps, now: Date = new Date()): Promise<number> {
  if (d.mailer.configured === false) return 0;
  const { rows: biz } = await d.pool.query<{
    business_name: string;
    tz: string | null;
    currency: string | null;
  }>("SELECT business_name, timezone AS tz, currency FROM settings WHERE id = 1");
  const tz = biz[0]?.tz ?? "UTC";
  const w = wall(now, tz);
  if (w.weekday !== 1 || w.hour < 9) return 0;
  const weekStart = shift(w.date, -7);
  const weekEnd = shift(w.date, -1);
  const { rows: people } = await d.pool.query<{
    id: string;
    email: string;
    name: string;
    preferences: unknown;
  }>("SELECT id, email, name, preferences FROM users WHERE status = 'active' ORDER BY id");
  let sent = 0;
  for (const u of people) {
    try {
      // On unless switched off: a row saved before the switch existed has no answer, and gets the email.
      if (mergePreferences(u.preferences as never, {}).alerts.weeklyAnalytics === false) continue;
      const actor = await loadActor(d.pool, u.id);
      if (!actor || scopeOf(actor, "analytics.view") !== "all") continue;
      const claim = await d.pool.query(
        "INSERT INTO weekly_runs (user_id, week_start) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [u.id, weekStart],
      );
      if (!claim.rowCount) continue;
      try {
        const mail = await build(d, u, actor, weekStart, weekEnd, biz[0]?.business_name ?? "LUME", now);
        await d.mailer.send(mail);
        sent++;
      } catch (err) {
        // Give the week back: the next run tries again.
        await d.pool.query("DELETE FROM weekly_runs WHERE user_id = $1 AND week_start = $2", [
          u.id,
          weekStart,
        ]);
        throw err;
      }
    } catch (err) {
      d.log?.error({ err, userId: u.id }, "a weekly analytics email failed; the next run tries again");
    }
  }
  return sent;
}

async function build(
  d: WeeklyDeps,
  u: { id: string; email: string; name: string },
  actor: NonNullable<Awaited<ReturnType<typeof loadActor>>>,
  from: string,
  to: string,
  businessName: string,
  now: Date,
) {
  const c = await d.pool.connect();
  try {
    await c.query("BEGIN");
    await applyRequestScope(c, actor);
    // The numbers as this person reads them, through the same code the screens use.
    const req = { db: drizzle(c, { schema }), actor, log: d.log } as unknown as FastifyRequest;
    const q: AnalyticsQuery = { range: "custom", from, to, compare: true };
    const [ov, people, fun, noticed] = await Promise.all([
      overview(req, q, now),
      team(req, q, now),
      funnel(req, q, now),
      insights(req, q, now),
    ]);
    await c.query("COMMIT");
    const value = (id: MetricId) => ov.tiles.find((t) => t.id === id);
    const line = (id: MetricId, shown: (v: number) => string) => {
      const t = value(id);
      if (!t || t.value === null) return null;
      return `${METRICS[id].words} ${shown(t.value)}${t.trend ? ` (${t.trend.text})` : ""}`;
    };
    const tiles = [
      line("new_leads", fmt),
      line("won", fmt),
      line("revenue_won", (v) => fmt(Math.round(v))),
      line("win_rate", (v) => `${Math.round(v * 100)}%`),
      line("ontime", (v) => `${Math.round(v * 100)}% of follow-ups on time`),
    ].filter((x): x is string => !!x);
    const top = people.people.find((p) => p.won > 0);
    const drop = fun.stages
      .filter((s) => s.reached >= 10 && s.kind !== "won" && s.stopped !== null)
      .sort((a, b) => b.stopped! - a.stopped!)[0];
    return weeklyAnalyticsMail({
      to: u.email,
      firstName: u.name.trim().split(/\s+/)[0] || u.name,
      businessName,
      url: `${d.publicUrl.replace(/\/$/, "")}/analytics`,
      week: `last week (${ov.range.label})`,
      tiles,
      topPerson: top ? `Most wins: ${top.name}, ${fmt(top.won)}` : null,
      dropStage: drop
        ? `Most leads stopped at ${drop.name} (${Math.round(drop.stopped! * 100)}% went no further)`
        : null,
      overdue: value("overdue_now")?.value ?? 0,
      insight:
        noticed.ready && noticed.insights[0]
          ? { title: noticed.insights[0].title, body: noticed.insights[0].body }
          : null,
    });
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
