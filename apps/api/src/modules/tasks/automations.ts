import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { leadScope, newId, onEnterSchema, shiftToWorkingHours, type StageRule } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { loadActor } from "../../rbac/actor";
import { recordActivity } from "../leads/writer";
import { notify, type NewNotification } from "../notifications/notify";
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

/**
 * Whether a person is active here and could see a lead with this owner (`lume_can_see_owner`), looked up
 * once per request: a bulk move of 100 leads asks about the same few people.
 */
const people = new WeakMap<FastifyRequest, Map<string, ReturnType<typeof loadActor>>>();
async function canTake(
  req: FastifyRequest,
  pool: pg.Pool,
  userId: string,
  ownerId: string | null,
): Promise<boolean> {
  let known = people.get(req);
  if (!known) people.set(req, (known = new Map()));
  if (!known.has(userId))
    known.set(
      userId,
      loadActor(pool, userId).catch((e: unknown) => {
        known.delete(userId); // a lookup that failed is asked again, not remembered
        throw e;
      }),
    );
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
  o: {
    deps?: AutomationDeps | undefined;
    /** A lead from a webhook or a sheet: nobody made the move (its source runs as someone, who hears). */
    intake?: boolean;
  } = {},
): Promise<void> {
  const deps = o.deps ?? req.server.automationDeps;
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
    mover: o.intake ? null : req.actor!.userId,
  };
  for (const rule of parsed.data.rules) {
    // Each rule on its own: one that fails is rolled back and said, and the move and the next rule go on
    // (3C final review, Important 5).
    await req.db.execute(sql`SAVEPOINT lume_rule`);
    try {
      if (rule.type === "create_task") await setFollowUp(req, deps, lead, rule, ctx);
      else if (rule.type === "remind_before_meeting") await remindBefore(req, deps, lead, rule, ctx);
      else if (rule.type === "cancel_open_tasks") {
        const cancelled = await cancelLeadTasks(req, lead.id);
        if (cancelled) await say(req, lead, rule, "done", { cancelled }); // nothing open: nothing to say
      } else await tell(req, deps, lead, stage, rule, why, ctx.mover);
      await req.db.execute(sql`RELEASE SAVEPOINT lume_rule`);
    } catch (err) {
      await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_rule`);
      await req.db.execute(sql`RELEASE SAVEPOINT lume_rule`);
      req.log.error({ err, ruleId: rule.id }, "a stage automation failed; the move went ahead");
      await say(req, lead, rule, "skipped", { reason: "failed" });
    }
  }
}

/**
 * Notices from rules, gathered per request and said once each: a bulk move of 100 leads tells a person
 * "LUME set you 100 follow-ups", not 100 times (3C final review, Important 4).
 */
type Notice = {
  pool: pg.Pool;
  userId: string;
  one: NewNotification;
  count: number;
  many: (n: number) => NewNotification;
};
const notices = new WeakMap<FastifyRequest, Map<string, Notice>>();
/**
 * A queued bulk run is many requests, one a chunk: its chunks' notices are gathered together and said once, when the
 * run ends (7B final review, Important 3). A chunk adds to the run's group only once it has committed.
 */
export type NoticeGroup = Map<string, Notice>;
const groups = new WeakMap<FastifyRequest, NoticeGroup>();
export const newNoticeGroup = (): NoticeGroup => new Map();
export function shareNoticesInto(req: FastifyRequest, group: NoticeGroup): void {
  groups.set(req, group);
}
export function sayNotices(group: NoticeGroup, log: FastifyRequest["log"] | FastifyInstance["log"]): void {
  for (const x of group.values())
    void notify(x.pool, x.userId, x.count === 1 ? x.one : x.many(x.count)).catch((err: unknown) =>
      log.error({ err }, "couldn't tell someone what a stage did"),
    );
  group.clear();
}
function gather(req: FastifyRequest, key: string, n: Omit<Notice, "count">) {
  let all = notices.get(req);
  if (!all) {
    const fresh = new Map<string, Notice>();
    notices.set(req, (all = fresh));
    req.afterCommit(() => {
      const into = groups.get(req);
      if (into)
        for (const [k, x] of fresh) {
          const had = into.get(k);
          if (had) had.count += x.count;
          else into.set(k, { ...x });
        }
      else sayNotices(fresh, req.log);
    });
  }
  const had = all.get(key);
  if (had) had.count++;
  else all.set(key, { ...n, count: 1 });
}

/** One line in the lead's history for each rule that ran: what it did, or why it couldn't. */
const say = (
  req: FastifyRequest,
  lead: Lead,
  rule: StageRule,
  result: "done" | "skipped",
  extra: Record<string, unknown> = {},
) => recordActivity(req, lead.id, "automation", { ruleId: rule.id, rule: rule.type, result, ...extra });

/**
 * A meeting kept for a lead already in its stage (a Calendly booking that moved nothing, 5C final review):
 * that stage's meeting reminders run now, as they would have on entering it with the meeting there.
 */
export async function remindForStage(req: FastifyRequest, lead: Lead & { stageId: string }) {
  const deps = req.server.automationDeps;
  const [stage] = await req.db
    .select({ onEnter: schema.stages.onEnter })
    .from(schema.stages)
    .where(eq(schema.stages.id, lead.stageId));
  const parsed = onEnterSchema.safeParse(stage?.onEnter);
  if (!deps || !parsed.success) return;
  for (const rule of parsed.data.rules)
    if (rule.type === "remind_before_meeting")
      await remindBefore(req, deps, lead, rule, { now: new Date(), mover: req.actor?.userId ?? null });
}

/**
 * 5C: a WhatsApp follow-up for the lead's owner, with the rule's template, due `hoursBefore` before the
 * lead's next meeting — so the reminder goes out in time. Nothing, said why, when there's no meeting to come,
 * that time has passed, the template is gone, or nobody owns the lead.
 */
async function remindBefore(
  req: FastifyRequest,
  deps: AutomationDeps,
  lead: Lead,
  rule: Extract<StageRule, { type: "remind_before_meeting" }>,
  ctx: { now: Date; mover: string | null },
) {
  if (!lead.ownerId) return say(req, lead, rule, "skipped", { reason: "no_owner" });
  const m = (
    await req.db.execute<{ id: string; title: string; starts_at: string | Date }>(
      sql`SELECT id, title, starts_at FROM meetings WHERE lead_id = ${lead.id} AND status = 'scheduled'
            AND starts_at > ${ctx.now} ORDER BY starts_at LIMIT 1`,
    )
  ).rows[0];
  if (!m) return say(req, lead, rule, "skipped", { reason: "no_meeting" });
  const dueAt = new Date(new Date(m.starts_at).getTime() - rule.hoursBefore * UNIT_MS.hour);
  if (dueAt <= ctx.now) return say(req, lead, rule, "skipped", { reason: "too_late" });
  const [t] = await req.db
    .select({ id: schema.messageTemplates.id })
    .from(schema.messageTemplates)
    .where(and(eq(schema.messageTemplates.id, rule.templateId), isNull(schema.messageTemplates.archivedAt)));
  if (!t) return say(req, lead, rule, "skipped", { reason: "no_template" });
  const open = await req.db.execute(
    sql`SELECT 1 FROM tasks WHERE lead_id = ${lead.id} AND auto_rule_id = ${rule.id} AND status = 'open' LIMIT 1`,
  );
  if (open.rows.length) return say(req, lead, rule, "skipped", { reason: "already_open" });
  const id = newId();
  const title = `Remind ${lead.name} about ${m.title}`.slice(0, 200);
  const [task] = await req.db
    .insert(schema.tasks)
    .values({
      id,
      leadId: lead.id,
      assigneeId: lead.ownerId,
      type: "whatsapp",
      templateId: rule.templateId,
      meetingId: m.id,
      title,
      dueAt,
      remindMinutes: [0],
      seriesId: id,
      createdBy: ctx.mover,
      autoRuleId: rule.id,
    })
    .returning();
  await schedule(req.db, task!, ctx.now);
  await refreshNextDue(req, lead.id);
  await say(req, lead, rule, "done", {
    taskId: id,
    assigneeId: lead.ownerId,
    title,
    dueAt: dueAt.toISOString(),
  });
  const pending = await pendingOf(req.db, [id]);
  if (pending.length)
    req.afterCommit(
      () =>
        void deps.tasks
          ?.enqueue(pending)
          .catch((err: unknown) =>
            req.log.error({ err }, "couldn't queue a rule's reminder; the sweeper will"),
          ),
    );
}

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
    mover: string | null;
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
      createdBy: ctx.mover, // a webhook's or sheet's follow-up has no author: LUME set it
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
  if (pending.length)
    req.afterCommit(
      () =>
        void deps.tasks
          ?.enqueue(pending)
          .catch((err: unknown) =>
            req.log.error({ err }, "couldn't queue a rule's reminder; the sweeper will"),
          ),
    );
  // The assignee hears, unless they made the move themselves.
  if (assigneeId !== ctx.mover)
    gather(req, `assigned:${assigneeId}`, {
      pool: deps.pool,
      userId: assigneeId,
      one: {
        kind: "follow_up_assigned",
        title: `LUME set you a follow-up — ${lead.name}`,
        body: rule.title,
        leadId: lead.id,
        taskId: id,
      },
      many: (n) => ({ kind: "follow_up_assigned", title: `LUME set you ${n} follow-ups` }),
    });
}

async function tell(
  req: FastifyRequest,
  deps: AutomationDeps,
  lead: Lead,
  stage: Stage,
  rule: Extract<StageRule, { type: "notify" }>,
  why: "moved" | "created",
  mover: string | null,
) {
  const ids = [...new Set(rule.to.map((p) => (p === "lead_owner" ? lead.ownerId : p.userId)))].filter(
    (id): id is string => !!id && id !== mover, // never the person who made the move
  );
  const told: string[] = [];
  for (const id of ids) if (await canTake(req, deps.pool, id, lead.ownerId)) told.push(id);
  await say(req, lead, rule, told.length ? "done" : "skipped", told.length ? { told } : { reason: "nobody" });
  const verb = why === "moved" ? "moved to" : "arrived in";
  for (const id of told)
    gather(req, `stage:${id}:${stage.id}:${why}`, {
      pool: deps.pool,
      userId: id,
      one: { kind: "lead_stage", title: `${lead.name} ${verb} ${stage.name}`, leadId: lead.id },
      many: (n) => ({ kind: "lead_stage", title: `${n} leads ${verb} ${stage.name}` }),
    });
}
