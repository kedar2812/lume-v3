import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, newId, scopeOf } from "@lume/core";
import { audit } from "../../audit/audit";
import { badRequest, forbidden, notFound } from "../../http/errors";
import { businessTz } from "./service";

/**
 * Goals (8B, spec §3, §4 `goal_progress`): targets for a person, a team or the business, for a month or a quarter.
 * Admins set them (settings.manage); everyone sees the goals within their analytics reach, with progress and the
 * pace "at this pace" — an estimate, labelled as one.
 */
export type GoalMetric = "won" | "revenue" | "calls_held" | "new_leads" | "ontime";
export type GoalInput = {
  scope: "user" | "team" | "business";
  scopeId: string | null;
  metric: GoalMetric;
  period: "month" | "quarter";
  periodStart: string;
  target: number;
};

const periodEnd = (start: string, period: "month" | "quarter") => {
  const [y, m] = start.split("-").map(Number);
  const end = new Date(Date.UTC(y!, m! - 1 + (period === "month" ? 1 : 3), 0));
  return end.toISOString().slice(0, 10);
};

function checkStart(g: GoalInput) {
  if (!/^\d{4}-\d{2}-01$/.test(g.periodStart))
    throw badRequest("BAD_PERIOD", "A goal's period starts on the 1st of a month.");
  if (g.period === "quarter" && ![1, 4, 7, 10].includes(Number(g.periodStart.slice(5, 7))))
    throw badRequest("BAD_PERIOD", "A quarter starts in January, April, July or October.");
  if ((g.scope === "business") !== (g.scopeId === null))
    throw badRequest("BAD_GOAL", "Say who the goal is for.");
}

/** Sets one goal (the same scope, metric and period replace the old target). */
export async function setGoal(req: FastifyRequest, g: GoalInput) {
  if (!can(req.actor!, "settings.manage")) throw forbidden();
  checkStart(g);
  const r = await req.db.execute<{ id: string }>(sql`
    INSERT INTO goals (id, scope, scope_id, metric, period, period_start, target, created_by)
    VALUES (${newId()}::uuid, ${g.scope}, ${g.scopeId}::uuid, ${g.metric}, ${g.period}, ${g.periodStart}::date, ${g.target}, ${req.actor!.userId}::uuid)
    ON CONFLICT (scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'), metric, period, period_start)
    DO UPDATE SET target = EXCLUDED.target, updated_at = now()
    RETURNING id`);
  await audit(req, {
    action: "analytics.goal.set",
    entityType: "goal",
    entityId: r.rows[0]!.id,
    diff: { ...g },
  });
  return { id: r.rows[0]!.id };
}

export async function removeGoal(req: FastifyRequest, id: string) {
  if (!can(req.actor!, "settings.manage")) throw forbidden();
  const r = await req.db.execute(sql`DELETE FROM goals WHERE id = ${id}::uuid`);
  if (!r.rowCount) throw notFound("GOAL_NOT_FOUND", "That goal isn't there any more.");
  await audit(req, { action: "analytics.goal.removed", entityType: "goal", entityId: id });
}

/** The goals for a period that the viewer may see, each with progress so far and the pace. */
export async function listGoals(
  req: FastifyRequest,
  periodStart: string,
  period: "month" | "quarter",
  now: Date,
) {
  const actor = req.actor!;
  const reach = scopeOf(actor, "analytics.view");
  if (!reach) throw forbidden();
  checkStart({ scope: "business", scopeId: null, metric: "won", period, periodStart, target: 1 });
  const end = periodEnd(periodStart, period);
  const tz = await businessTz(req);
  const rows = (
    await req.db.execute<{
      id: string;
      scope: GoalInput["scope"];
      scope_id: string | null;
      metric: GoalMetric;
      target: string;
    }>(sql`
      SELECT id, scope, scope_id, metric, target::text FROM goals WHERE period = ${period} AND period_start = ${periodStart}::date`)
  ).rows;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const days = Math.round((Date.parse(end) - Date.parse(periodStart)) / 86_400_000) + 1;
  const gone = Math.min(
    days,
    Math.max(0, Math.round((Date.parse(today) - Date.parse(periodStart)) / 86_400_000) + 1),
  );
  const money = can(actor, "analytics.revenue");
  // Three reads whatever the number of goals (a business with hundreds of people sets hundreds): every team's
  // members, and the period's sums per person from each rollup. A team or the business adds up its people.
  const teamIds = [...new Set(rows.filter((g) => g.scope === "team").map((g) => g.scope_id!))];
  type Sums = { arrived: number; won: number; wonValue: number; held: number; onTime: number; done: number };
  const zero = (): Sums => ({ arrived: 0, won: 0, wonValue: 0, held: 0, onTime: 0, done: 0 });
  const [members, cohort, events] = rows.length
    ? await Promise.all([
        teamIds.length
          ? req.db.execute<{ team_id: string; user_id: string }>(
              sql`SELECT team_id, user_id FROM team_members WHERE team_id = ANY(${`{${teamIds.join(",")}}`}::uuid[])`,
            )
          : Promise.resolve({ rows: [] as { team_id: string; user_id: string }[] }),
        req.db.execute<{ user_id: string | null; arrived: number }>(sql`
          SELECT user_id, coalesce(sum(arrived), 0)::float8 AS arrived FROM analytics_daily_cohort
          WHERE day BETWEEN ${periodStart}::date AND ${end}::date GROUP BY user_id`),
        req.db.execute<{
          user_id: string | null;
          won: number;
          won_value: number;
          held: number;
          on_time: number;
          done: number;
        }>(sql`
          SELECT user_id, coalesce(sum(won), 0)::float8 AS won, coalesce(sum(won_value), 0)::float8 AS won_value,
                 coalesce(sum(held), 0)::float8 AS held, coalesce(sum(tasks_on_time), 0)::float8 AS on_time,
                 coalesce(sum(tasks_done), 0)::float8 AS done
          FROM analytics_daily_event WHERE day BETWEEN ${periodStart}::date AND ${end}::date GROUP BY user_id`),
      ])
    : [{ rows: [] }, { rows: [] }, { rows: [] }];
  const byUser = new Map<string | null, Sums>();
  const at = (u: string | null) => byUser.get(u) ?? (byUser.set(u, zero()), byUser.get(u)!);
  for (const r of cohort.rows) at(r.user_id).arrived += r.arrived;
  for (const r of events.rows) {
    const x = at(r.user_id);
    x.won += r.won;
    x.wonValue += r.won_value;
    x.held += r.held;
    x.onTime += r.on_time;
    x.done += r.done;
  }
  const teamOf = new Map<string, string[]>();
  for (const m of members.rows) teamOf.set(m.team_id, [...(teamOf.get(m.team_id) ?? []), m.user_id]);
  const sumOf = (users: string[] | null): Sums => {
    const out = zero();
    for (const [u, x] of byUser) {
      if (users && (u === null || !users.includes(u))) continue;
      out.arrived += x.arrived;
      out.won += x.won;
      out.wonValue += x.wonValue;
      out.held += x.held;
      out.onTime += x.onTime;
      out.done += x.done;
    }
    return out;
  };
  const out = [];
  for (const g of rows) {
    if (g.metric === "revenue" && !money) continue;
    const users =
      g.scope === "user" ? [g.scope_id!] : g.scope === "team" ? (teamOf.get(g.scope_id!) ?? []) : null;
    // Within reach: one's own goal always; a team's or the business's with a reach that covers it.
    const visible =
      reach === "all" ||
      (g.scope === "user" &&
        (g.scope_id === actor.userId || (reach === "team" && actor.teamMemberIds.includes(g.scope_id!)))) ||
      (g.scope === "team" &&
        reach === "team" &&
        users!.every((u) => u === actor.userId || actor.teamMemberIds.includes(u)));
    if (!visible) continue;
    const x = sumOf(users);
    const value =
      g.metric === "new_leads"
        ? x.arrived
        : g.metric === "won"
          ? x.won
          : g.metric === "revenue"
            ? x.wonValue
            : g.metric === "calls_held"
              ? x.held
              : x.done
                ? x.onTime / x.done
                : 0;
    const target = Number(g.target);
    const elapsed = gone / days;
    out.push({
      id: g.id,
      scope: g.scope,
      scopeId: g.scope_id,
      metric: g.metric,
      target,
      value,
      progress: value / target,
      // A rate's pace is the rate itself; counts and money run on at the pace so far. An estimate, said as one.
      pace: g.metric === "ontime" ? value / target : elapsed > 0 ? value / elapsed / target : null,
      elapsed,
      daysLeft: days - gone,
    });
  }
  return { period, periodStart, periodEnd: end, goals: out };
}

/** Every source still in use, with its monthly spend (Settings → Sources & spend). */
export async function listSpend(req: FastifyRequest) {
  if (!can(req.actor!, "settings.manage")) throw forbidden();
  const r = await req.db.execute<{
    id: string;
    name: string;
    type: string;
    status: string;
    spend: string | null;
  }>(sql`
    SELECT id, name, type, status, monthly_spend::text AS spend FROM lead_sources
    WHERE status <> 'archived' ORDER BY name`);
  return {
    sources: r.rows.map((x) => ({
      id: x.id,
      name: x.name,
      type: x.type,
      status: x.status,
      monthlySpend: x.spend === null ? null : Number(x.spend),
    })),
  };
}

/** What a source costs a month (8B): spread over a range by its days on the Sources board. */
export async function setSpend(req: FastifyRequest, sourceId: string, monthlySpend: number | null) {
  if (!can(req.actor!, "settings.manage")) throw forbidden();
  const r = await req.db.execute(
    sql`UPDATE lead_sources SET monthly_spend = ${monthlySpend} WHERE id = ${sourceId}::uuid`,
  );
  if (!r.rowCount) throw notFound("SOURCE_NOT_FOUND", "That source isn't there any more.");
  await audit(req, {
    action: "source.spend.set",
    entityType: "lead_source",
    entityId: sourceId,
    diff: { monthlySpend },
  });
  return { id: sourceId, monthlySpend };
}
