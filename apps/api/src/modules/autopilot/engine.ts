import { createHash } from "node:crypto";
import {
  ACTIVE_STATES,
  autopilotFirstOutput,
  autopilotInput,
  autopilotInstructions,
  autopilotReplyOutput,
  can,
  dailyBudget,
  firstNameOf,
  followUpMoment,
  guardFirst,
  guardReply,
  newId,
  mergeAiProfile,
  nextMove,
  nextSendAt,
  paramsFor,
  renderMarked,
  revealMs,
  shiftToWorkingHours,
  tierLimitOf,
  valueOf,
  type AiProfile,
  type AutopilotCtx,
  type GuardedReply,
  type LeadState,
  type PauseReason,
} from "@lume/core";
import { schema, type RunGoal } from "@lume/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import type { AppDeps } from "../../app";
import { HttpError } from "../../http/errors";
import { loadActor } from "../../rbac/actor";
import { openStages, filesOf } from "../ai/profile";
import { aiStatus, runRead } from "../ai/service";
import { jobServer, withJobRequest } from "../imports/job-request";
import { setDoNotContact } from "../leads/dnc";
import { contextFor } from "../leads/sending";
import type { LeadRow } from "../leads/serialize";
import { visibleLead } from "../leads/service";
import { moveStage } from "../leads/write";
import { adminIds, notify } from "../notifications/notify";
import { workingHoursFrom } from "../settings/follow-ups";
import { createTask } from "../tasks/service";
import { attachLibraryFile, sendReply } from "../whatsapp/send";
import { allScope } from "../whatsapp/sender";
import { approvedFor, labelsOf, sendTemplate } from "../whatsapp/template-send";
import { tellPeople } from "./ready";

export type EngineDeps = { app: FastifyInstance; d: AppDeps };
type Run = typeof schema.autopilotRuns.$inferSelect;
type Lead = typeof schema.autopilotLeads.$inferSelect;
/** The run's own pacing replaces a person's per-minute limit (spec §6). */
const UNLIMITED = { take: () => ({ ok: true as const }) };
/** A lead whose message LUME AI couldn't write this many times goes to a person. */
const MAX_FAILS = 3;

const poolOf = (d: AppDeps) => d.jobPool ?? d.pool;
const say = (c: pg.PoolClient | pg.Pool, runId: string, leadId: string | null, kind: string, data = {}) =>
  c.query("INSERT INTO autopilot_events (run_id, lead_id, kind, data) VALUES ($1, $2, $3, $4)", [
    runId,
    leadId,
    kind,
    JSON.stringify(data),
  ]);

/** A run's event about a lead, as the speaker (the lead's row-level security admits it). */
const sayIn = (req: FastifyRequest, runId: string, leadId: string, kind: string) =>
  req.db.insert(schema.autopilotEvents).values({ runId, leadId, kind });

/** Pause a running run (spec §2.1): from now nothing is sent; a queued message is cancelled by the send job. */
export async function pauseRun(pool: pg.Pool, runId: string, reason: PauseReason): Promise<boolean> {
  const r = await pool.query(
    `UPDATE autopilot_runs SET status = 'paused', pause_reason = $2, updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [runId, reason],
  );
  if (r.rowCount) await say(pool, runId, null, "paused", { reason });
  return !!r.rowCount;
}

/** Resume a paused run: it carries on from the same place (a written draft goes as it is). */
export async function resumeRun(pool: pg.Pool, runId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE autopilot_runs SET status = 'running', pause_reason = NULL, updated_at = now()
      WHERE id = $1 AND status = 'paused'`,
    [runId],
  );
  if (r.rowCount) await say(pool, runId, null, "resumed");
  return !!r.rowCount;
}

/** End a run (§2.1): nothing more is sent; every lead keeps its conversation and state, and is free for another run. */
export async function endRun(pool: pg.Pool, runId: string): Promise<boolean> {
  return allScope(pool, async (c) => {
    const r = await c.query(
      `UPDATE autopilot_runs SET status = 'ended', pause_reason = NULL, ended_at = now(), updated_at = now()
        WHERE id = $1 AND status <> 'ended'`,
      [runId],
    );
    if (!r.rowCount) return false;
    await c.query("UPDATE autopilot_leads SET active = false, updated_at = now() WHERE run_id = $1", [runId]);
    await say(c, runId, null, "ended");
    return true;
  });
}

/** Every running run on a number (WhatsApp rated it yellow or red, or it was disconnected): paused (§6). */
export async function pauseRunsOnNumber(pool: pg.Pool, numberId: string, reason: PauseReason): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM autopilot_runs WHERE number_id = $1 AND status = 'running'",
    [numberId],
  );
  for (const r of rows) await pauseRun(pool, r.id, reason);
}

/** Runs with something due now, and runs paused by the month's allowance (they resume by themselves after a top-up). */
export async function dueRuns(pool: pg.Pool, now: Date): Promise<string[]> {
  return allScope(pool, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT DISTINCT r.id FROM autopilot_runs r
         JOIN autopilot_leads l ON l.run_id = r.id AND l.active
        WHERE (r.status = 'running' AND l.state = ANY($2) AND (l.next_at IS NULL OR l.next_at <= $1))
           OR (r.status = 'paused' AND r.pause_reason = 'month')`,
      // Only leads LUME AI is working on: one that's with a person, or ready for them, waits for that person.
      [now, ACTIVE_STATES],
    );
    return rows.map((r) => r.id);
  });
}

/** A stable key for one message of a run, so a retried step never sends it twice (the outbox's client key). */
function messageKey(runId: string, leadId: string, n: string): string {
  const h = createHash("sha256").update(`${runId}:${leadId}:${n}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * One step of a run (spec §1–§3, §6), under a lock so a run never steps twice at once. Returns how many things it did
 * (a message written or sent, a lead moved on), 0 when nothing was due.
 */
export async function stepRun(o: EngineDeps, runId: string): Promise<number> {
  const pool = poolOf(o.d);
  const lock = await pool.connect();
  try {
    const got = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [
      `autopilot:${runId}`,
    ]);
    if (!got.rows[0]?.ok) return 0;
    try {
      return await step(o, runId);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [`autopilot:${runId}`]);
    }
  } finally {
    lock.release();
  }
}

async function step(o: EngineDeps, runId: string): Promise<number> {
  const pool = poolOf(o.d);
  const [run] = (await pool.query<Run>(`SELECT * FROM autopilot_runs WHERE id = $1`, [runId])).rows.map(
    camel<Run>,
  );
  if (!run || run.status === "ended") return 0;
  if (run.status === "paused" && run.pauseReason !== "month") return 0;

  const actor = await loadActor(pool, run.speakerId);
  if (!actor || !can(actor, "messages.send")) {
    if (await pauseRun(pool, runId, "speaker"))
      for (const id of await adminIds(pool))
        await notify(pool, id, {
          kind: "system_alert",
          title: "LUME AI paused a run: its speaker can't message leads",
          body: `"${run.name}" waits for a new speaker. Start it again as someone who may send messages.`,
        });
    return 1;
  }
  const now = o.d.clock();
  return withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `autopilot:${runId}`, allLeads: false },
    async (req) => {
      if (run.status === "paused") {
        // Paused by the month's allowance: a top-up (a larger allowance) lets it carry on by itself.
        const ai = await aiStatus(req, o.d);
        if (ai.month.limit === null || ai.month.used < ai.month.limit) {
          await resumeRun(pool, runId);
          return 1;
        }
        return 0;
      }
      const [number] = await req.db
        .select({
          status: schema.whatsappNumbers.status,
          quality: schema.whatsappNumbers.quality,
          tier: schema.whatsappNumbers.messagingTier,
          waba: schema.whatsappNumbers.wabaId,
        })
        .from(schema.whatsappNumbers)
        .where(eq(schema.whatsappNumbers.id, run.numberId));
      if (!number || number.status !== "active") return (await pauseRun(pool, runId, "number")) ? 1 : 0;
      if (number.quality === "yellow" || number.quality === "red")
        return (await pauseRun(pool, runId, "quality")) ? 1 : 0;

      const [s] = await req.db
        .select({ tz: schema.settings.timezone, wh: schema.settings.workingHours })
        .from(schema.settings)
        .where(eq(schema.settings.id, 1));
      const tz = s?.tz ?? "UTC";
      const wh = workingHoursFrom(s?.wh);
      const L = schema.autopilotLeads;
      const leads = await req.db
        .select()
        .from(L)
        .where(and(eq(L.runId, runId), eq(L.active, true)));

      // One lead at a time: a message being written goes when the screen has revealed it.
      const writing = leads.find((l) => l.state === "writing");
      if (writing) {
        if (writing.nextAt && writing.nextAt > now) return 0;
        return sendStep(o, req, run, writing);
      }
      const due = leads
        .filter((l) => ACTIVE_STATES.includes(l.state) && (!l.nextAt || l.nextAt <= now))
        .sort((a, b) => (a.nextAt?.getTime() ?? 0) - (b.nextAt?.getTime() ?? 0));
      let acted = 0;
      for (const l of due) {
        const move = nextMove(l, { now, followUpDays: run.followUpDays });
        if (move.kind === "wait") {
          // Woken when it's due; a wait that changes nothing isn't work (the job would step again at once).
          if ((l.nextAt?.getTime() ?? null) !== (move.until?.getTime() ?? null)) {
            await req.db.update(L).set({ nextAt: move.until, updatedAt: now }).where(keyOf(l));
            acted++;
          }
          continue;
        }
        if (move.kind === "done") {
          await req.db
            .update(L)
            .set({
              active: false,
              nextAt: null,
              reason: "No reply after the last follow-up.",
              updatedAt: now,
            })
            .where(keyOf(l));
          acted++;
          continue;
        }
        if (move.kind === "reply") {
          // A reply to someone who just wrote: within hours unless the business chose to reply any time (§3).
          const at = shiftToWorkingHours(now, wh, tz);
          if (run.outsideHours === "wait" && at > now) {
            await req.db.update(L).set({ nextAt: at, updatedAt: now }).where(keyOf(l));
            acted++;
            continue;
          }
          return acted + (await writeReply(o, req, run, l));
        }
        // A first message or a follow-up: an approved template, paced under Meta's tier and the cap (§6).
        const sentToday = await templatesToday(pool, run.numberId, now, tz);
        const lastSent = leads.reduce<Date | null>(
          (m, x) => (x.lastSentAt && (!m || x.lastSentAt > m) ? x.lastSentAt : m),
          null,
        );
        const budgetLeft = dailyBudget({ tierLimit: tierLimitOf(number.tier), cap: run.dailyCap, sentToday });
        const at = nextSendAt({ now, wh, tz, budgetLeft, lastSentAt: lastSent });
        if (at > now) return acted;
        return acted + (await writeTemplate(o, req, run, l, number.waba, move.kind === "first" ? 0 : move.n));
      }
      return acted;
    },
  );
}

const keyOf = (l: { runId: string; leadId: string }) =>
  and(eq(schema.autopilotLeads.runId, l.runId), eq(schema.autopilotLeads.leadId, l.leadId))!;

/** Templates this number started today on the business's clock, every sender's (§1.2: minus what the team sent). */
async function templatesToday(pool: pg.Pool, numberId: string, now: Date, tz: string): Promise<number> {
  return allScope(pool, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM whatsapp_outbox
        WHERE number_id = $1 AND submission_id IS NOT NULL AND status NOT IN ('failed', 'cancelled')
          AND created_at >= (date_trunc('day', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3)`,
      [numberId, now, tz],
    );
    return Number(rows[0]?.n ?? 0);
  });
}

/** The lead, as the speaker sees it now; null when they can't any more (moved out of their reach, or gone). */
async function leadNow(req: FastifyRequest, leadId: string): Promise<LeadRow | null> {
  return visibleLead(req, leadId).catch((e: unknown) => {
    if (e instanceof HttpError) return null;
    throw e;
  });
}

async function leave(
  req: FastifyRequest,
  l: Lead,
  state: LeadState,
  reason: string,
  card?: { headline: string; quote: string | null },
) {
  await req.db
    .update(schema.autopilotLeads)
    .set({
      state,
      reason,
      ...(card ? { card } : {}),
      active: state === "skipped" || state === "stopped" ? false : l.active,
      draft: null,
      draftPayload: null,
      thought: null,
      nextAt: null,
      updatedAt: new Date(),
    })
    .where(keyOf(l));
  await req.db.insert(schema.autopilotEvents).values({ runId: l.runId, leadId: l.leadId, kind: state });
  return 1;
}

/** Choose and fill an approved template for a first message or a follow-up (§3): never a variable invented or blank. */
async function writeTemplate(o: EngineDeps, req: FastifyRequest, run: Run, l: Lead, waba: string, n: number) {
  const lead = await leadNow(req, l.leadId);
  if (!lead) return leave(req, l, "skipped", "LUME AI can't reach this lead any more.");
  if (lead.dncAt) return leave(req, l, "skipped", "Asked not to be messaged.");
  const ctx = await contextFor(req, lead);
  const options = await approvedFor(req, waba, lead);
  const fits = options
    .map((t) => ({ t, p: paramsFor(t.tokens, ctx) }))
    .filter((x) => x.p.missing.length === 0)
    .map((x) => x.t);
  if (!fits.length) {
    if (!options.length)
      return leave(req, l, "skipped", "No approved WhatsApp template yet. Submit one in Templates.");
    const labels = labelsOf(ctx.fields as never);
    const missing = paramsFor(options[0]!.tokens, ctx).missing.map((t) => labels.get(t) ?? t);
    return leave(
      req,
      l,
      "skipped",
      `No approved template fits this lead yet: it has no ${missing.join(", ")}.`,
    );
  }
  let chosen = fits[0]!;
  let thought = `Only one approved template fits ${firstNameOf(lead.name ?? "") || "this lead"}, so LUME AI uses it.`;
  if (fits.length > 1) {
    const c = await aiCtx(
      req,
      run,
      lead,
      fits.map((t) => ({ id: t.id, name: t.name, body: t.body })),
    );
    const r = await runRead(req, o.d, {
      task: "autopilot_first",
      leadId: lead.id,
      instructions: autopilotInstructions("autopilot_first", c),
      input: autopilotInput("autopilot_first", c),
      schema: autopilotFirstOutput,
      maxOutputTokens: 300,
    });
    if ("unavailable" in r) return unavailable(o, req, run, l, r);
    const id = guardFirst(
      r.output,
      fits.map((t) => t.id),
    );
    chosen = fits.find((t) => t.id === id) ?? chosen;
    thought = r.output.why.trim().slice(0, 200) || `LUME AI chose ${chosen.name}.`;
  }
  // Where its filled values sit, so the screen can highlight them as it types (A3).
  const { text: draft, marks } = renderMarked(chosen.body, ctx);
  await req.db
    .update(schema.autopilotLeads)
    .set({
      state: "writing",
      draft,
      draftPayload: { kind: "template", submissionId: chosen.id, n, marks },
      thought,
      nextAt: new Date(o.d.clock().getTime() + revealMs(draft)),
      fails: 0,
      updatedAt: o.d.clock(),
    })
    .where(keyOf(l));
  await sayIn(req, run.id, l.leadId, "draft");
  return 1;
}

/** The read's facts for LUME AI: the business's own words and lists, the lead, and the thread (§3). */
async function aiCtx(
  req: FastifyRequest,
  run: Run,
  lead: LeadRow,
  templates: AutopilotCtx["templates"],
): Promise<AutopilotCtx & { profileRaw: AiProfile; leadWords: string; lastLeadMessage: string }> {
  const [s] = await req.db
    .select({
      name: schema.settings.businessName,
      tz: schema.settings.timezone,
      currency: schema.settings.currency,
    })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  const [p] = await req.db.select({ p: schema.aiProfile.profile }).from(schema.aiProfile);
  const profile = mergeAiProfile(p?.p ?? null, {});
  const [speaker] = await req.db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, run.speakerId));
  const ctx = await contextFor(req, lead);
  // The fields this speaker may see, by the labels people pick them by (as the template variables are named).
  const labels = labelsOf(ctx.fields as never);
  const fields = ctx.fields
    .map((f) => ({
      label: labels.get(`lead.custom.${f.key}`) ?? f.key,
      value: valueOf(`lead.custom.${f.key}`, ctx),
    }))
    .filter((f): f is { label: string; value: string } => !!f.value);
  const A = schema.activities;
  const acts = (
    await req.db
      .select({ type: A.type, at: A.occurredAt, payload: A.payload })
      .from(A)
      .where(and(eq(A.leadId, lead.id), inArray(A.type, ["whatsapp_received", "whatsapp_sent"])))
      .orderBy(sql`${A.occurredAt} DESC`)
      .limit(30)
  ).reverse();
  const thread = acts
    .map((a) => ({
      from: a.type === "whatsapp_received" ? ("lead" as const) : ("business" as const),
      at: a.at.toISOString(),
      text: String((a.payload as { text?: string | null }).text ?? ""),
    }))
    .filter((m) => m.text);
  const theirs = thread.filter((m) => m.from === "lead");
  const stage = (await openStages(req)).find((x) => x.id === lead.stageId)?.name ?? "";
  const goal = run.goal as RunGoal;
  const goalName =
    goal.kind === "stage"
      ? ((await openStages(req)).find((x) => x.id === goal.stageId)?.name ?? "the goal stage")
      : "";
  const files = (await filesOf(req, profile.knows.files)).filter((f) => !f.archived);
  return {
    business: s?.name ?? "",
    speaker: speaker?.name ?? "",
    goal: goal.kind === "stage" ? { kind: "stage", stage: goalName } : goal,
    profile,
    profileRaw: profile,
    currency: s?.currency ?? "",
    lead: { firstName: (lead.name ?? "").split(/\s+/)[0] ?? "", stage, fields },
    thread,
    templates,
    files: files.map((f) => ({ id: f.id, name: f.name })),
    now: new Date().toISOString(),
    timezone: s?.tz ?? "UTC",
    leadWords: theirs
      .slice(-5)
      .map((m) => m.text)
      .join("\n"),
    lastLeadMessage: theirs.at(-1)?.text ?? "",
  };
}

/**
 * A lead now in the run's goal stage (§1.1: reached when it moves into it, by LUME AI or anyone): converted, to Ready for
 * you with their own last words. True when it was.
 */
async function reachedGoal(o: EngineDeps, req: FastifyRequest, run: Run, l: Lead): Promise<boolean> {
  const goal = run.goal as RunGoal;
  if (goal.kind !== "stage") return false;
  const lead = await leadNow(req, l.leadId);
  if (!lead || lead.stageId !== goal.stageId) return false;
  const stage = (await openStages(req)).find((x) => x.id === goal.stageId)?.name ?? "the goal";
  const A = schema.activities;
  const [last] = await req.db
    .select({ payload: A.payload })
    .from(A)
    .where(and(eq(A.leadId, lead.id), eq(A.type, "whatsapp_received")))
    .orderBy(sql`${A.occurredAt} DESC`)
    .limit(1);
  const quote = (last?.payload as { text?: string | null } | undefined)?.text ?? null;
  const headline = `Reached ${stage}`;
  await leave(req, l, "ready", headline, { headline, quote });
  const pool = poolOf(o.d);
  req.afterCommit(() => void tellPeople(pool, { runId: run.id, leadId: lead.id, kind: "ready", headline }));
  return true;
}

/** Write a reply inside the 24 hours (§3), guarded (Task 2), as the speaker. */
async function writeReply(o: EngineDeps, req: FastifyRequest, run: Run, l: Lead) {
  const lead = await leadNow(req, l.leadId);
  if (!lead) return leave(req, l, "skipped", "LUME AI can't reach this lead any more.");
  if (lead.dncAt) return leave(req, l, "stopped", "Asked not to be messaged.");
  if (await reachedGoal(o, req, run, l)) return 1;
  const c = await aiCtx(req, run, lead, []);
  const r = await runRead(req, o.d, {
    task: "autopilot_reply",
    leadId: lead.id,
    instructions: autopilotInstructions("autopilot_reply", c),
    input: autopilotInput("autopilot_reply", c),
    schema: autopilotReplyOutput,
    maxOutputTokens: 1200,
  });
  if ("unavailable" in r) return unavailable(o, req, run, l, r);
  const stages = await req.db
    .select({ id: schema.stages.id, kind: schema.stages.kind })
    .from(schema.stages)
    .where(eq(schema.stages.pipelineId, lead.pipelineId));
  const reasons = await req.db.select({ id: schema.lostReasons.id }).from(schema.lostReasons);
  const fieldKeys = ((await contextFor(req, lead)).fields as { key: string }[]).map((f) => f.key);
  const g = guardReply(r.output, {
    prices: c.profile.knows.prices.map((x) => x.price),
    fileIds: c.files.map((f) => f.id),
    leadWords: c.leadWords,
    lastLeadMessage: c.lastLeadMessage,
    permissions: run.permissions,
    openStageIds: stages.filter((x) => x.kind === "open").map((x) => x.id),
    lostStageIds: stages.filter((x) => x.kind === "lost").map((x) => x.id),
    lostReasonIds: reasons.map((x) => x.id),
    fieldKeys,
  });
  return actOn(o, req, run, l, lead, g, c.lastLeadMessage, r.output.reason);
}

/** What a guarded answer does to the lead (§2–§3). Stop, ask and Ready for you are finished in Tasks 7–8. */
async function actOn(
  o: EngineDeps,
  req: FastifyRequest,
  run: Run,
  l: Lead,
  lead: LeadRow,
  g: GuardedReply,
  theirWords: string,
  /** LUME AI's own reason, the live view's thought line. */
  reason: string,
) {
  if (g.kind === "stop") {
    await setDoNotContact(req, lead.id, { reason: "Said stop on WhatsApp", byAi: { runId: run.id } });
    // The one apology a stop allows (§3), with do not contact: the same as a stop LUME's own list catches.
    await queueApology(o, req, run.id, lead.id);
    return leave(req, l, "stopped", "Said stop. LUME AI marked them do not contact.");
  }
  const pool = poolOf(o.d);
  if (g.kind === "handover") {
    const headline = g.reason;
    req.afterCommit(
      () => void tellPeople(pool, { runId: run.id, leadId: lead.id, kind: "needs_you", headline }),
    );
    return leave(req, l, "needs_you", g.reason, { headline: g.reason, quote: g.evidence });
  }
  if (g.kind === "converted") {
    const headline = g.reason;
    req.afterCommit(() => void tellPeople(pool, { runId: run.id, leadId: lead.id, kind: "ready", headline }));
    return leave(req, l, "ready", g.reason, {
      headline: g.reason,
      quote: g.evidence ?? (theirWords || null),
    });
  }
  if (g.kind === "ask") {
    await req.db.insert(schema.autopilotAsks).values({
      id: newId(),
      runId: run.id,
      leadId: lead.id,
      action: g.action,
      payload: { message: g.message, fileIds: g.fileIds, updates: g.updates },
    });
    const action = g.action;
    req.afterCommit(() => void tellPeople(pool, { runId: run.id, leadId: lead.id, kind: "ask", action }));
    return leave(req, l, "needs_you", "LUME AI is waiting for you to approve its next step.", {
      headline: "Waiting for you",
      quote: theirWords || null,
    });
  }
  await req.db
    .update(schema.autopilotLeads)
    .set({
      state: "writing",
      draft: g.message,
      draftPayload: { kind: "reply", fileIds: g.fileIds, updates: g.updates },
      thought: reason.trim().slice(0, 200) || null,
      nextAt: new Date(o.d.clock().getTime() + revealMs(g.message)),
      fails: 0,
      updatedAt: o.d.clock(),
    })
    .where(keyOf(l));
  await sayIn(req, run.id, l.leadId, "draft");
  return 1;
}

/** LUME AI couldn't read now (§4): the month pauses the run, the hour waits, a failure is tried again (three times). */
async function unavailable(
  o: EngineDeps,
  req: FastifyRequest,
  run: Run,
  l: Lead,
  r: { unavailable: string; by?: string; until?: string },
) {
  if (r.unavailable === "limit" && r.by === "month")
    return (await pauseRun(poolOf(o.d), run.id, "month")) ? 1 : 0;
  if (r.unavailable === "limit") {
    await req.db
      .update(schema.autopilotLeads)
      .set({ nextAt: new Date(r.until!), updatedAt: o.d.clock() })
      .where(keyOf(l));
    return 1;
  }
  if (r.unavailable === "off" || r.unavailable === "not_configured")
    return (await pauseRun(poolOf(o.d), run.id, "person")) ? 1 : 0;
  if (l.fails + 1 >= MAX_FAILS)
    return leave(req, l, "needs_you", "LUME AI couldn't write to this lead just now.");
  await req.db
    .update(schema.autopilotLeads)
    .set({ fails: l.fails + 1, nextAt: new Date(o.d.clock().getTime() + 5 * 60_000), updatedAt: o.d.clock() })
    .where(keyOf(l));
  return 1;
}

/**
 * Send what was written (§2.1): in one transaction that locks the run and the lead, still running and the lead still
 * LUME AI's, queued as the speaker through the same checks a person's send passes. A pause waits on this lock, and the
 * send job checks again before Meta.
 */
async function sendStep(o: EngineDeps, req: FastifyRequest, run: Run, l: Lead): Promise<number> {
  const live = (
    await req.db.execute<{ status: string }>(
      sql`SELECT status FROM autopilot_runs WHERE id = ${run.id} FOR UPDATE`,
    )
  ).rows[0];
  if (live?.status !== "running") return 0;
  const L = schema.autopilotLeads;
  const [now] = await req.db.select().from(L).where(keyOf(l)).for("update");
  if (!now || now.state !== "writing" || !now.active || !now.draft) return 0;
  const p = (now.draftPayload ?? {}) as {
    kind?: "template" | "reply";
    submissionId?: string;
    n?: number;
    fileIds?: string[];
    updates?: {
      stageId: string | null;
      fields: Record<string, string>;
      followUp: { at: string; title: string } | null;
      lostReasonId: string | null;
    };
  };
  // One key per message as written: a retried step never sends it twice, and one written again after a Pause held it
  // (unsent.ts) is a new message, not the held one.
  const key = (part: string) =>
    messageKey(run.id, l.leadId, `${now.lastSentAt?.getTime() ?? 0}:${now.updatedAt.getTime()}:${part}`);
  const auto = { runId: run.id };
  try {
    await req.db.execute(sql`SAVEPOINT autopilot_send`);
    if (p.kind === "template")
      await sendTemplate(
        req,
        o.d,
        UNLIMITED,
        l.leadId,
        { submissionId: p.submissionId!, clientKey: key("t") },
        auto,
      );
    else {
      await sendReply(req, o.d, UNLIMITED, l.leadId, { clientKey: key("m"), text: now.draft }, auto);
      for (const [i, f] of (p.fileIds ?? []).entries()) {
        const { media } = await attachLibraryFile(req, o.d, l.leadId, f);
        await sendReply(req, o.d, UNLIMITED, l.leadId, { clientKey: key(`f${i}`), mediaId: media.id }, auto);
      }
    }
    await req.db.execute(sql`RELEASE SAVEPOINT autopilot_send`);
  } catch (e) {
    await req.db.execute(sql`ROLLBACK TO SAVEPOINT autopilot_send`);
    if (!(e instanceof HttpError)) throw e;
    if (e.code === "PAID_LIMIT") return (await pauseRun(poolOf(o.d), run.id, "paid")) ? 1 : 0;
    return leave(req, now, "needs_you", e.message);
  }
  const at = o.d.clock();
  await req.db
    .update(L)
    .set({
      state: p.kind === "template" ? "sent" : "talking",
      firstSentAt: now.firstSentAt ?? at,
      lastSentAt: at,
      followUpsSent: p.kind === "template" ? (p.n ?? 0) : 0,
      draft: null,
      draftPayload: null,
      thought: null,
      nextAt: null,
      updatedAt: at,
    })
    .where(keyOf(l));
  if (p.kind === "reply" && p.updates) await applyUpdates(o, req, l.leadId, p.updates);
  await sayIn(req, run.id, l.leadId, "sent");
  // The lead's move into the goal stage (by this reply's update, or anyone's): converted.
  await reachedGoal(o, req, run, { ...now, state: p.kind === "template" ? "sent" : "talking" });
  return 1;
}

/** What LUME AI may change on the lead with a reply (the guards allowed it): each on its own, one failing never the rest. */
async function applyUpdates(
  o: EngineDeps,
  req: FastifyRequest,
  leadId: string,
  u: {
    stageId: string | null;
    fields: Record<string, string>;
    followUp: { at: string; title: string } | null;
    lostReasonId: string | null;
  },
) {
  const attempt = async (part: string, fn: () => Promise<unknown>) => {
    await req.db.execute(sql.raw(`SAVEPOINT autopilot_${part}`));
    try {
      await fn();
      await req.db.execute(sql.raw(`RELEASE SAVEPOINT autopilot_${part}`));
    } catch (e) {
      await req.db.execute(sql.raw(`ROLLBACK TO SAVEPOINT autopilot_${part}`));
      req.log.warn({ err: e, part }, "LUME AI couldn't make a change it was allowed to");
    }
  };
  if (u.stageId) {
    const stageId = u.stageId;
    await attempt("stage", async () => {
      const lead = await visibleLead(req, leadId);
      await moveStage(
        req,
        lead,
        { stageId, ...(u.lostReasonId ? { lostReasonId: u.lostReasonId } : {}) },
        { via: "ai_autopilot" },
      );
    });
  }
  if (u.followUp) {
    const f = u.followUp;
    await attempt("follow_up", async () => {
      const [s] = await req.db.select({ tz: schema.settings.timezone }).from(schema.settings);
      const due = followUpMoment(f, s?.tz ?? "UTC");
      if (due.getTime() > o.d.clock().getTime())
        await createTask(
          req,
          o.d,
          leadId,
          { title: f.title, due: { at: due.toISOString() } },
          { via: "ai_autopilot" },
        );
    });
  }
}

/** A row from `SELECT *`, its columns in camelCase (the engine reads runs with plain SQL under its lock). */
function camel<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
  ) as T;
}

/** The one message a stop allows (§3): short, never debated, in the business's sign-off when it has one. */
export const STOP_APOLOGY = "Sorry for the messages. You won't hear from us again.";

/**
 * After a lead in a running run said stop (do not contact is already set): one apology, as the speaker, inside the 24
 * hours they just opened. Only while the run is running; a paused run sends nothing, not even this.
 */
export async function sendStopApology(o: EngineDeps, runId: string, leadId: string): Promise<void> {
  const pool = poolOf(o.d);
  const run = (
    await pool.query<{ status: string; speaker_id: string }>(
      "SELECT status, speaker_id FROM autopilot_runs WHERE id = $1",
      [runId],
    )
  ).rows[0];
  if (run?.status !== "running") return;
  const actor = await loadActor(pool, run.speaker_id);
  if (!actor) return;
  await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `autopilot-stop:${runId}:${leadId}`, allLeads: false },
    (req) => queueApology(o, req, runId, leadId),
  );
}

/** Queue the apology, as the speaker: one per lead and run, whichever way the stop was heard (one key). */
async function queueApology(
  o: EngineDeps,
  req: FastifyRequest,
  runId: string,
  leadId: string,
): Promise<void> {
  const [p] = await req.db.select({ p: schema.aiProfile.profile }).from(schema.aiProfile);
  const signOff = mergeAiProfile(p?.p ?? null, {}).voice.signOff.trim();
  const text = signOff ? `${STOP_APOLOGY}\n${signOff}` : STOP_APOLOGY;
  await req.db.execute(sql`SAVEPOINT autopilot_apology`);
  try {
    await sendReply(
      req,
      o.d,
      UNLIMITED,
      leadId,
      { clientKey: messageKey(runId, leadId, "stop"), text },
      { runId, afterStop: true },
    );
    await req.db.execute(sql`RELEASE SAVEPOINT autopilot_apology`);
  } catch (err) {
    // Never at the cost of the stop itself: do not contact stands without it.
    await req.db.execute(sql`ROLLBACK TO SAVEPOINT autopilot_apology`);
    req.log.warn({ err }, "LUME AI couldn't send its apology for a stop");
  }
}
