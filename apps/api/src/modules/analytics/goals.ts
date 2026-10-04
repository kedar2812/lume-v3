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
  const teamOf = async (teamId: string) =>
    (
      await req.db.execute<{ user_id: string }>(
        sql`SELECT user_id FROM team_members WHERE team_id = ${teamId}::uuid`,
      )
    ).rows.map((r) => r.user_id);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const days = Math.round((Date.parse(end) - Date.parse(periodStart)) / 86_400_000) + 1;
  const gone = Math.min(
    days,
    Math.max(0, Math.round((Date.parse(today) - Date.parse(periodStart)) / 86_400_000) + 1),
  );
  const money = can(actor, "analytics.revenue");
  const out = [];
  for (const g of rows) {
    if (g.metric === "revenue" && !money) continue;
    const users = g.scope === "user" ? [g.scope_id!] : g.scope === "team" ? await teamOf(g.scope_id!) : null;
    // Within reach: one's own goal always; a team's or the business's with a reach that covers it.
    const visible =
      reach === "all" ||
      (g.scope === "user" &&
        (g.scope_id === actor.userId || (reach === "team" && actor.teamMemberIds.includes(g.scope_id!)))) ||
      (g.scope === "team" &&
        reach === "team" &&
        users!.every((u) => u === actor.userId || actor.teamMemberIds.includes(u)));
    if (!visible) continue;
    const who = users ? sql`AND user_id = ANY(${`{${users.join(",")}}`}::uuid[])` : sql``;
    const span = sql`day BETWEEN ${periodStart}::date AND ${end}::date ${who}`;
    let value: number;
    if (g.metric === "new_leads")
      value = (
        await req.db.execute<{ v: number }>(
          sql`SELECT coalesce(sum(arrived), 0)::float8 AS v FROM analytics_daily_cohort WHERE ${span}`,
        )
      ).rows[0]!.v;
    else {
      const col = { won: "won", revenue: "won_value", calls_held: "held", ontime: "tasks_on_time" }[g.metric];
      const r = (
        await req.db.execute<{ v: number; done: number }>(sql`
          SELECT coalesce(sum(${sql.raw(col)}), 0)::float8 AS v, coalesce(sum(tasks_done), 0)::float8 AS done
          FROM analytics_daily_event WHERE ${span}`)
      ).rows[0]!;
      value = g.metric === "ontime" ? (r.done ? r.v / r.done : 0) : r.v;
    }
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
