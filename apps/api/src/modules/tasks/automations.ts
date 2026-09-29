import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { leadScope, newId, onEnterSchema, shiftToWorkingHours, type StageRule } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { loadActor } from "../../rbac/actor";
import { recordActivity } from "../leads/writer";
import { notify } from "../notifications/notify";
import { followUpsFrom, workingHoursFrom } from "../settings/follow-ups";
import { pendingOf, schedule } from "./engine";
import { cancelLeadTasks, refreshNextDue } from "./lifecycle";

/** What a stage's rules need beyond the request: the pool (to ask about people) and the reminder queue. */
export type AutomationDeps = { pool: pg.Pool; tasks?: AppDeps["tasks"] };

declare module "fastify" {
  interface FastifyInstance {
    /** Stage automations' dependencies, in requests (3C). Jobs pass their own. */
    automationDeps?: AutomationDeps;
  }
}

type Lead = { id: string; name: string; ownerId: string | null };
type Stage = { id: string; name: string; onEnter: unknown };
const UNIT_MS = { hour: 3_600_000, day: 86_400_000 } as const;

/** Whether a person is active here and could see a lead with this owner (`lume_can_see_owner`). */
/** A person's access, looked up once per request: a bulk move of 100 leads asks about the same few people. */
const people = new WeakMap<FastifyRequest, Map<string, ReturnType<typeof loadActor>>>();
async function canTake(
  req: FastifyRequest,
  pool: pg.Pool,
  userId: string,
  ownerId: string | null,
): Promise<boolean> {
  let known = people.get(req);
  if (!known) people.set(req, (known = new Map()));
  if (!known.has(userId)) known.set(userId, loadActor(pool, userId));
  const a = await known.get(userId)!;
  if (!a) return false; // nobody who isn't active
  const s = leadScope(a);
  if (s === "all") return true;
  if (!ownerId) return false;
  return ownerId === userId || (s === "team" && a.teamMemberIds.includes(ownerId));
}

/**
 * What a stage does when a lead enters it (3C Task 3; report §10.5), in rule order, inside the change's own
 * transaction. A rule never stands in the way of the move: one that can't do its work says why in the
 * lead's history and the next one runs. No rule moves a stage, so a rule can never set another off.
 */
export async function runOnEnter(
  req: FastifyRequest,
  lead: Lead,
  stage: Stage,
  why: "moved" | "created",
  deps: AutomationDeps | undefined = req.server.automationDeps,
): Promise<void> {
  const parsed = onEnterSchema.safeParse(stage.onEnter);
  if (!deps || !parsed.success || !parsed.data.rules.length) return;
  const [s] = await req.db
    .select({ f: schema.settings.followUps, wh: schema.settings.workingHours, tz: schema.settings.timezone })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  const ctx = {
    settings: followUpsFrom(s?.f),
    hours: workingHoursFrom(s?.wh),
    tz: s?.tz ?? "UTC",
    now: new Date(),
  };
  for (const rule of parsed.data.rules) {
    if (rule.type === "create_task") await setFollowUp(req, deps, lead, rule, ctx);
    else if (rule.type === "cancel_open_tasks") {
      const cancelled = await cancelLeadTasks(req, lead.id);
      await say(req, lead, rule, "done", { cancelled });
    } else await tell(req, deps, lead, stage, rule, why);
  }
}

/** One line in the lead's history for each rule that ran: what it did, or why it couldn't. */
const say = (
  req: FastifyRequest,
  lead: Lead,
  rule: StageRule,
  result: "done" | "skipped",
  extra: Record<string, unknown> = {},
) => recordActivity(req, lead.id, "automation", { ruleId: rule.id, rule: rule.type, result, ...extra });

async function setFollowUp(
  req: FastifyRequest,
  deps: AutomationDeps,
  lead: Lead,
  rule: Extract<StageRule, { type: "create_task" }>,
  ctx: {
    settings: ReturnType<typeof followUpsFrom>;
    hours: ReturnType<typeof workingHoursFrom>;
    tz: string;
    now: Date;
  },
) {
  // The named person, else the lead's owner (Review Focus 3); with neither, nothing.
  const wanted = rule.assignee === "lead_owner" ? lead.ownerId : rule.assignee.userId;
  let assigneeId: string | null = null;
  if (wanted && (await canTake(req, deps.pool, wanted, lead.ownerId))) assigneeId = wanted;
  else if (lead.ownerId && (await canTake(req, deps.pool, lead.ownerId, lead.ownerId)))
    assigneeId = lead.ownerId;
  if (!assigneeId)
    return say(req, lead, rule, "skipped", { reason: lead.ownerId ? "owner_unavailable" : "no_owner" });
  // One open follow-up per rule per lead: moving out and back in doesn't stack them (Review Focus 1).
  const open = await req.db.execute(
    sql`SELECT 1 FROM tasks WHERE lead_id = ${lead.id} AND auto_rule_id = ${rule.id} AND status = 'open' LIMIT 1`,
  );
  if (open.rows.length) return say(req, lead, rule, "skipped", { reason: "already_open" });

  let dueAt = new Date(ctx.now.getTime() + rule.dueIn.n * UNIT_MS[rule.dueIn.unit]);
  if (ctx.settings.shiftToWorkingHours) dueAt = shiftToWorkingHours(dueAt, ctx.hours, ctx.tz);
  const id = newId();
  const [t] = await req.db
    .insert(schema.tasks)
    .values({
      id,
      leadId: lead.id,
      assigneeId,
      title: rule.title,
      dueAt,
      remindMinutes: [0],
      seriesId: id,
      createdBy: req.actor!.userId,
      autoRuleId: rule.id,
    })
    .returning();
  await schedule(req.db, t!, ctx.now);
  await refreshNextDue(req, lead.id);
  await say(req, lead, rule, "done", {
    taskId: id,
    assigneeId,
    title: rule.title,
    dueAt: dueAt.toISOString(),
  });
  const pending = await pendingOf(req.db, [id]);
  const by = req.actor!.userId;
  req.afterCommit(() => {
    if (pending.length)
      void deps.tasks
        ?.enqueue(pending)
        .catch((err: unknown) =>
          req.log.error({ err }, "couldn't queue a rule's reminder; the sweeper will"),
        );
    // The assignee hears, unless they made the move themselves.
    if (assigneeId !== by)
      void notify(deps.pool, assigneeId!, {
        kind: "follow_up_assigned",
        title: `LUME set you a follow-up — ${lead.name}`,
        body: rule.title,
        leadId: lead.id,
        taskId: id,
      }).catch((err: unknown) => req.log.error({ err }, "couldn't tell the assignee"));
  });
}

async function tell(
  req: FastifyRequest,
  deps: AutomationDeps,
  lead: Lead,
  stage: Stage,
  rule: Extract<StageRule, { type: "notify" }>,
  why: "moved" | "created",
) {
  const ids = [...new Set(rule.to.map((p) => (p === "lead_owner" ? lead.ownerId : p.userId)))].filter(
    (id): id is string => !!id && id !== req.actor!.userId, // never the person who made the move
  );
  const told: string[] = [];
  for (const id of ids) if (await canTake(req, deps.pool, id, lead.ownerId)) told.push(id);
  await say(req, lead, rule, told.length ? "done" : "skipped", told.length ? { told } : { reason: "nobody" });
  const title =
    why === "moved" ? `${lead.name} moved to ${stage.name}` : `${lead.name} arrived in ${stage.name}`;
  req.afterCommit(() => {
    for (const id of told)
      void notify(deps.pool, id, { kind: "lead_stage", title, leadId: lead.id }).catch((err: unknown) =>
        req.log.error({ err }, "couldn't tell someone a lead moved"),
      );
  });
}
