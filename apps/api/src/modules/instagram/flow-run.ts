import {
  IG_PRIVATE_REPLY_MS,
  instagramWindow,
  matchKeyword,
  newId,
  privateReplyOpen,
  stepFlow,
  NEW_RUN,
  type FlowAction,
  type FlowEvent,
  type FlowGraph,
  type FlowStep,
  type KeywordMode,
  type RunState,
} from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { HttpError } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { recordActivity } from "../leads/writer";
import { tagIdsOf, updateLead, visibleLead } from "../leads/service";
import { assignLead, moveStage } from "../leads/write";
import { giveBackLead, roomForLead } from "./budgets";
import { createInstagramLead, type IgAccountRow } from "./leads";

/**
 * Flows at work (NEW_FEATURES_PLAN §4.5; plan 1B Tasks 4–5; spec 2026-11-22 §2). Everything here runs inside the
 * transaction that keeps the delivery, as whoever connected the account (seeing every lead): the delivery and what
 * the flow does with it are one, so a delivery processed twice does nothing twice. Messages go through the outbox
 * (keyed by run and step) and the sender, which checks Meta's window and the account's pace again before Meta.
 *
 * Who answers (spec §2): a person who took the conversation over; else LUME AI holding the lead; else a flow already
 * running; else the flow whose trigger matches; else the team.
 */
export type FlowAccount = IgAccountRow & {
  runAs: string;
  automatedNote: string | null;
  personWords: string[];
};
/** What to do once the delivery's transaction commits: queue the sends, the public reply, tell whoever was handed a lead. */
export type FlowOut = {
  sends: string[];
  publicReply: { commentId: string; text: string } | null;
  notices: { ownerId: string; leadId: string; title: string; body: string }[];
  /** "Tell my team" steps addressed to the admins: who they are is read once the transaction is done. */
  adminNotices: { leadId: string; title: string; body: string }[];
  /** "Tell my team" steps addressed to one person, who hears the lead's name only if they may see that lead. */
  userNotices: { userId: string; leadId: string; leadOwner: string | null; title: string; body: string }[];
  /** Follow-ups a flow made, created as the account's run-as person once the transaction is done (as a person would). */
  tasks: { leadId: string; title: string; dueMinutes: number; runAs: string }[];
  /** A new person was turned away: the account's new leads this hour are used up (the admins hear once an hour). */
  held: boolean;
};
export const newFlowOut = (): FlowOut => ({
  sends: [],
  publicReply: null,
  notices: [],
  adminNotices: [],
  userNotices: [],
  tasks: [],
  held: false,
});
/** "Go to another flow" may hop at most this many times in one turn (A → B → C → D stops), so two flows can't ping-pong. */
export const GOTO_HOPS = 3;

/**
 * A Postgres array as one parameter (drizzle would spread a JS array into a row): each element quoted, so commas,
 * quotes and backslashes in a keyword stay themselves.
 */
export const pgArray = (xs: readonly string[]): string =>
  `{${xs.map((x) => `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;

const firstName = (n: string | null) => n?.trim().split(/\s+/)[0] || null;

export const FLOW_WORDS = {
  takenOver: "A person took this conversation over.",
  dnc: "The lead asked not to be messaged.",
  leadGone: "The lead was deleted.",
  noAnswer: "The person didn't answer while Instagram allowed a reply.",
  accountGone: "The Instagram account was disconnected.",
  ai: "LUME AI is answering this lead.",
  cantRun: "Whoever connected this Instagram account can't see leads any more.",
  archived: "This flow was archived.",
  gotoGone: "The flow this one goes on to isn't live.",
  gotoHops: "Flows passed this conversation on too many times in a row.",
} as const;

/** How a run ended, as the interpreter says it: the run's status, and words when it stopped short. */
function endOf(reason: string): { status: "done" | "handed" | "stopped"; reason: string | null } {
  if (reason === "handed") return { status: "handed", reason: null };
  if (reason === "finished" || reason === "went to another flow" || reason === "no answer")
    return { status: "done", reason: null };
  return { status: "stopped", reason };
}

type Run = {
  id: string;
  flow_id: string;
  version_id: string;
  trigger_id: string | null;
  thread_id: string;
  lead_id: string;
  state: RunState;
  keyword: string | null;
  started_by: string;
  steps: FlowStep[] | FlowGraph;
  flow_status: string;
};

type Candidate = {
  trigger_id: string;
  flow_id: string;
  version_id: string;
  kind: string;
  keywords: string[];
  mode: KeywordMode;
  media_ids: string[];
  ad_ids: string[];
  public_replies: string[];
  cooldown_hours: number;
  priority: number;
};

/** Live flows' enabled triggers of these kinds for this account (or every account), best first. */
async function candidates(req: FastifyRequest, accountId: string, kinds: string[]): Promise<Candidate[]> {
  const r = await req.db.execute<Candidate>(sql`
    SELECT t.id AS trigger_id, f.id AS flow_id, f.live_version_id AS version_id, t.kind, t.keywords, t.mode,
           t.media_ids, t.ad_ids, t.public_replies, t.cooldown_hours, f.priority
      FROM instagram_triggers t JOIN instagram_flows f ON f.id = t.flow_id
     WHERE t.enabled AND f.status = 'live' AND f.live_version_id IS NOT NULL
       AND t.kind = ANY(${pgArray(kinds)}::text[]) AND (t.account_id IS NULL OR t.account_id = ${accountId})
     ORDER BY f.priority DESC, f.created_at, t.created_at`);
  return r.rows;
}

/**
 * The trigger that starts, and the keyword it matched (null for kinds without one). A keyword beats "any", a narrower
 * trigger (a post, an ad) beats a broad one, then the flow's priority; the list comes in priority order.
 */
function pick(
  cands: Candidate[],
  text: string | null,
  o: { mediaId?: string | null; adId?: string | null; kindOrder?: (kind: string) => number },
): { c: Candidate; keyword: string | null } | null {
  let best: { c: Candidate; keyword: string | null; rank: number } | null = null;
  for (const c of cands) {
    if (c.media_ids.length && (!o.mediaId || !c.media_ids.includes(o.mediaId))) continue;
    if (c.ad_ids.length && (!o.adId || !c.ad_ids.includes(o.adId))) continue;
    let keyword: string | null = null;
    if (c.kind === "comment" || c.kind === "dm") {
      const k = matchKeyword(text, c.keywords, c.mode);
      if (k === null) continue;
      keyword = c.mode === "any" ? null : k;
    }
    const rank =
      (o.kindOrder?.(c.kind) ?? 0) * 10 +
      (keyword !== null ? 0 : 2) +
      (c.media_ids.length || c.ad_ids.length ? 0 : 1);
    if (!best || rank < best.rank) best = { c, keyword, rank };
  }
  return best ? { c: best.c, keyword: best.keyword } : null;
}

/** Room this hour for one more public reply under this account's comments (each is stamped when queued). */
async function publicRoom(req: FastifyRequest, accountId: string, now: Date, perHour: number) {
  const r = await req.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM instagram_comments
     WHERE account_id = ${accountId} AND public_reply_at > ${new Date(now.getTime() - 3_600_000)}`);
  return r.rows[0]!.n < perHour;
}

/** The person was in this flow within its cool-down: a trigger doesn't start it again yet. */
async function cooling(req: FastifyRequest, threadId: string, c: Candidate, now: Date) {
  if (c.cooldown_hours <= 0) return false;
  const r = await req.db.execute(sql`
    SELECT 1 FROM instagram_flow_runs
     WHERE thread_id = ${threadId} AND flow_id = ${c.flow_id}
       AND created_at > ${new Date(now.getTime() - c.cooldown_hours * 3_600_000)} LIMIT 1`);
  return r.rows.length > 0;
}

/**
 * Why no flow may answer this conversation now, in words (spec §2 rows 1–2: a person took it over, LUME AI holds the
 * lead; or nobody may: do not contact, the lead deleted); null when a flow may.
 */
async function heldElsewhere(req: FastifyRequest, threadId: string, leadId: string): Promise<string | null> {
  const r = await req.db.execute<{ taken: boolean; dnc: boolean; gone: boolean; ai: boolean }>(sql`
    SELECT t.taken_over_by IS NOT NULL AS taken, l.dnc_at IS NOT NULL AS dnc, l.deleted_at IS NOT NULL AS gone,
           EXISTS (SELECT 1 FROM autopilot_leads a WHERE a.lead_id = l.id AND a.active) AS ai
      FROM instagram_threads t JOIN leads l ON l.id = ${leadId} WHERE t.id = ${threadId}`);
  const h = r.rows[0];
  if (!h) return FLOW_WORDS.leadGone;
  if (h.taken) return FLOW_WORDS.takenOver;
  if (h.gone) return FLOW_WORDS.leadGone;
  if (h.dnc) return FLOW_WORDS.dnc;
  if (h.ai) return FLOW_WORDS.ai;
  return null;
}

async function activeRun(req: FastifyRequest, threadId: string): Promise<Run | null> {
  const r = await req.db.execute<Run>(sql`
    SELECT r.id, r.flow_id, r.version_id, r.trigger_id, r.thread_id, r.lead_id, r.state, r.keyword, r.started_by,
           v.steps, f.status AS flow_status
      FROM instagram_flow_runs r
      JOIN instagram_flow_versions v ON v.id = r.version_id
      JOIN instagram_flows f ON f.id = r.flow_id
     WHERE r.thread_id = ${threadId} AND r.status IN ('running', 'waiting')
     FOR UPDATE OF r`);
  return r.rows[0] ?? null;
}

async function event(
  req: FastifyRequest,
  run: Pick<Run, "id" | "flow_id" | "version_id" | "trigger_id" | "keyword" | "lead_id">,
  kind: string,
  stepKey: string | null,
  /** When it happened: the delivery's (or the due run's) time, so ranges and cool-downs read one clock. */
  at: Date,
) {
  await req.db.execute(sql`
    INSERT INTO instagram_flow_events (flow_id, version_id, trigger_id, run_id, step_key, keyword, kind, lead_id, at)
    VALUES (${run.flow_id}, ${run.version_id}, ${run.trigger_id}, ${run.id}, ${stepKey}, ${run.keyword}, ${kind},
            ${run.lead_id}, ${at})
    ON CONFLICT DO NOTHING`);
}

/**
 * Active runs stop, saying why (a person took over, the lead said stop, the flow archived, the account gone…), and
 * whatever they still had waiting to go is cancelled with the same words: a stopped flow sends nothing more. Answers
 * how many stopped.
 */
export async function stopFlowRuns(
  req: FastifyRequest,
  where: { threadId: string } | { flowId: string } | { accountId: string },
  reason: string,
): Promise<number> {
  const which =
    "threadId" in where
      ? sql`thread_id = ${where.threadId}`
      : "flowId" in where
        ? sql`flow_id = ${where.flowId}`
        : sql`thread_id IN (SELECT id FROM instagram_threads WHERE account_id = ${where.accountId})`;
  const stopped = await req.db.execute<{ id: string }>(sql`
    UPDATE instagram_flow_runs SET status = 'stopped', reason = ${reason}, next_at = NULL, updated_at = now()
     WHERE status IN ('running', 'waiting') AND ${which}
     RETURNING id`);
  const ids = stopped.rows.map((r) => r.id);
  if (ids.length) await cancelQueued(req, ids, reason);
  return ids.length;
}

/** A stopped run's messages still waiting to go: cancelled with words; a private reply's comment is free again. */
async function cancelQueued(req: FastifyRequest, runIds: string[], reason: string) {
  const c = await req.db.execute<{ comment_id: string | null; flow_run_id: string; step_key: string }>(sql`
    UPDATE instagram_outbox SET status = 'cancelled', problem = ${reason}, updated_at = now()
     WHERE flow_run_id = ANY(${pgArray(runIds)}::uuid[]) AND status = 'queued'
     RETURNING comment_id, flow_run_id, step_key`);
  // What never went isn't counted as sent in the flow's numbers.
  if (c.rows.length)
    await req.db.execute(sql`
      DELETE FROM instagram_flow_events e
       USING unnest(${pgArray(c.rows.map((r) => r.flow_run_id))}::uuid[],
                    ${pgArray(c.rows.map((r) => r.step_key))}::text[]) AS x(run_id, step_key)
       WHERE e.run_id = x.run_id AND e.step_key = x.step_key AND e.kind IN ('dm_sent', 'private_reply')`);
  const comments = c.rows.map((r) => r.comment_id).filter((x): x is string => !!x);
  if (comments.length)
    await req.db.execute(sql`
      UPDATE instagram_comments SET private_reply = 'failed'
       WHERE comment_id = ANY(${pgArray(comments)}::text[]) AND private_reply = 'queued'`);
}

/** What the interpreter may read of the lead: its tags and its fields (core contact ones and custom ones). */
async function leadFacts(req: FastifyRequest, leadId: string) {
  const lead = await visibleLead(req, leadId);
  return {
    lead,
    facts: {
      tags: await tagIdsOf(req, leadId),
      fields: { ...(lead.custom ?? {}), name: lead.name, email: lead.email, phone: lead.phoneE164 } as Record<
        string,
        unknown
      >,
      stageId: lead.stageId,
      ownerId: lead.ownerId,
      sourceId: lead.sourceId,
    },
  };
}

/**
 * A lead write a flow asks for, inside a savepoint: one that can't be done (a field's rule, a stage's required
 * fields) is noted on the lead and the run goes on; it never undoes the messages or the delivery.
 */
async function tryWrite(req: FastifyRequest, leadId: string, what: string, fn: () => Promise<unknown>) {
  await req.db.execute(sql`SAVEPOINT lume_flow_write`);
  try {
    await fn();
    await req.db.execute(sql`RELEASE SAVEPOINT lume_flow_write`);
  } catch (e) {
    await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_flow_write`);
    if (!(e instanceof HttpError)) throw e;
    await recordActivity(req, leadId, "instagram_flow_problem", { what, problem: e.message });
  }
}

const CORE_SAVE: Record<string, "name" | "email" | "phone"> = {
  name: "name",
  email: "email",
  phone: "phone",
};

async function apply(
  req: FastifyRequest,
  account: FlowAccount,
  run: Run,
  a: FlowAction,
  ctx: { commentId: string | null },
  now: Date,
  out: FlowOut,
) {
  switch (a.kind) {
    case "send": {
      const id = newId();
      const ins = await req.db.execute(sql`
        INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, comment_id, text,
                                      quick_replies, buttons, flow_run_id, step_key, status, created_at, updated_at)
        VALUES (${id}, ${run.thread_id}, ${run.lead_id}, ${account.id}, ${account.runAs}, ${newId()},
                ${a.asPrivateReply ? "private_reply" : "dm"}, ${a.asPrivateReply ? ctx.commentId : null},
                ${a.message.text}, ${a.message.quickReplies?.length ? JSON.stringify(a.message.quickReplies) : null}::jsonb,
                ${a.message.buttons?.length ? JSON.stringify(a.message.buttons) : null}::jsonb, ${run.id}, ${a.stepKey},
                -- One step's messages in one transaction: the clock's own time keeps them in order for the sender.
                'queued', clock_timestamp(), clock_timestamp())
        ON CONFLICT (flow_run_id, step_key) DO NOTHING`);
      if (!ins.rowCount) return;
      out.sends.push(id);
      if (a.asPrivateReply && ctx.commentId)
        await req.db.execute(sql`
          UPDATE instagram_comments SET private_reply = 'queued', thread_id = coalesce(thread_id, ${run.thread_id})
           WHERE comment_id = ${ctx.commentId}`);
      await event(req, run, a.asPrivateReply ? "private_reply" : "dm_sent", a.stepKey, now);
      return;
    }
    case "saveField":
      await tryWrite(req, run.lead_id, `save ${a.field}`, async () => {
        const lead = await visibleLead(req, run.lead_id);
        const core = CORE_SAVE[a.field];
        // A question fills an empty field; it never overwrites what the business already has.
        if (core) {
          if (core === "phone" ? lead.phoneE164 : core === "email" ? lead.email : null) return;
          if (core === "name") return; // the name came from Instagram; a typed answer is kept as the answer only
          await updateLead(req, lead.id, lead.version, { [core]: a.value });
        } else {
          if (
            lead.custom?.[a.field] !== undefined &&
            lead.custom?.[a.field] !== null &&
            lead.custom?.[a.field] !== ""
          )
            return;
          const reg = await loadFieldRegistry(req);
          const def = reg.byKey.get(a.field);
          if (!def || def.isCore) return; // no lead field of that name: the answer stays on the run, for the flow
          const value = def?.type === "number" ? Number(a.value) : a.value;
          await updateLead(req, lead.id, lead.version, { custom: { [a.field]: value } });
        }
      });
      return;
    case "tag":
      await tryWrite(req, run.lead_id, "tag", async () => {
        const lead = await visibleLead(req, run.lead_id);
        const now = await tagIdsOf(req, lead.id);
        const next = a.add ? [...new Set([...now, a.tagId])] : now.filter((t) => t !== a.tagId);
        if (next.length !== now.length) await updateLead(req, lead.id, lead.version, { tagIds: next });
      });
      return;
    case "stage":
      await tryWrite(req, run.lead_id, "stage", async () =>
        moveStage(req, await visibleLead(req, run.lead_id), { stageId: a.stageId }),
      );
      return;
    case "assign":
      await tryWrite(req, run.lead_id, "assign", async () => {
        const lead = await visibleLead(req, run.lead_id);
        let to: string | null = null;
        if (a.to.mode === "user") to = a.to.userId;
        else if (a.to.mode === "source") to = account.ownerUserId ?? lead.ownerId;
        else if (a.to.userIds.length) {
          // Round robin among the people still active, in turn: one counter on the flow (never a count of its runs).
          const people = await req.db.execute<{ id: string }>(sql`
            SELECT id FROM users WHERE id = ANY(${pgArray(a.to.userIds)}::uuid[]) AND status = 'active' ORDER BY id`);
          if (people.rows.length) {
            const turn = await req.db.execute<{ rr: string }>(sql`
              UPDATE instagram_flows SET rr = rr + 1 WHERE id = ${run.flow_id} RETURNING rr`);
            to = people.rows[Number(turn.rows[0]!.rr) % people.rows.length]!.id;
          }
        }
        if (to && to !== lead.ownerId) await assignLead(req, lead, { ownerId: to, reason: "instagram_flow" });
      });
      return;
    case "clearField":
      await tryWrite(req, run.lead_id, `clear ${a.field}`, async () => {
        const lead = await visibleLead(req, run.lead_id);
        const core = CORE_SAVE[a.field];
        if (core === "name") return; // a lead always has a name
        if (core) {
          if ((core === "email" ? lead.email : lead.phoneE164) === null) return;
          await updateLead(req, lead.id, lead.version, { [core]: null });
          return;
        }
        const reg = await loadFieldRegistry(req);
        const def = reg.byKey.get(a.field);
        if (!def || def.isCore || lead.custom?.[a.field] === undefined || lead.custom?.[a.field] === null)
          return;
        await updateLead(req, lead.id, lead.version, { custom: { [a.field]: null } });
      });
      return;
    case "task":
      out.tasks.push({ leadId: run.lead_id, title: a.title, dueMinutes: a.dueMinutes, runAs: account.runAs });
      return;
    case "notify": {
      const lead = await visibleLead(req, run.lead_id);
      const title = `${firstName(lead.name) ?? "A lead"} on Instagram`;
      if (a.to === "admins") out.adminNotices.push({ leadId: lead.id, title, body: a.text });
      else if (a.to === "owner") {
        const who = lead.ownerId ?? account.ownerUserId;
        if (who) out.notices.push({ ownerId: who, leadId: lead.id, title, body: a.text });
      } else
        // A named person: told the lead's name only if they may see the lead (checked once the transaction is done).
        out.userNotices.push({
          userId: a.to.userId,
          leadId: lead.id,
          leadOwner: lead.ownerId,
          title,
          body: a.text,
        });
      return;
    }
    case "goto":
      // Started once this run has ended (see advance): one active run per conversation.
      return;
    case "handoff": {
      await event(req, run, "handed", "handoff", now);
      const lead = await visibleLead(req, run.lead_id);
      await recordActivity(req, lead.id, "instagram_flow_handed", {
        runId: run.id,
        flowId: run.flow_id,
        to: a.to,
        note: a.note,
      });
      const who = lead.ownerId ?? account.ownerUserId;
      if (who)
        out.notices.push({
          ownerId: who,
          leadId: lead.id,
          title: `${firstName(lead.name) ?? "A lead"} needs you on Instagram`,
          body: a.note || "A flow passed this conversation to you.",
        });
      return;
    }
  }
}

/** One turn of a run: the interpreter's answer applied, and the run's row saying where it is now. */
async function advance(
  req: FastifyRequest,
  account: FlowAccount,
  run: Run,
  ev: FlowEvent,
  now: Date,
  o: { privateReplyOnly: boolean; commentId: string | null; commentAt: Date | null },
  out: FlowOut,
) {
  const t = (
    await req.db.execute<{ last_in_at: Date | string | null; ad_window_until: Date | string | null }>(sql`
      SELECT last_in_at, ad_window_until FROM instagram_threads WHERE id = ${run.thread_id}`)
  ).rows[0]!;
  const at = (v: Date | string | null) => (v ? new Date(v) : null);
  const window = instagramWindow({ lastInAt: at(t.last_in_at), adWindowUntil: at(t.ad_window_until) }, now);
  const { facts } = await leadFacts(req, run.lead_id);
  const tz = (await req.db.execute<{ tz: string }>(sql`SELECT timezone AS tz FROM settings WHERE id = 1`))
    .rows[0]?.tz;
  const r = stepFlow(run.steps, run.state, ev, {
    now,
    window,
    privateReplyOnly: o.privateReplyOnly,
    lead: facts,
    personWords: account.personWords,
    ...(tz ? { tz } : {}),
    // A split test's path: the same run always takes the same one.
    seed: run.id,
  });
  // The automated-experience note goes once, before the run's first message in the person's inbox (not inside the
  // comment's one private reply, which belongs to what the business wrote).
  const firstDm = r.actions.findIndex((a) => a.kind === "send" && !a.asPrivateReply);
  if (account.automatedNote && firstDm >= 0 && !run.state.noted)
    r.actions.splice(firstDm, 0, {
      kind: "send",
      stepKey: "note",
      asPrivateReply: false,
      message: { text: account.automatedNote },
    });
  // Each step entered, for the numbers on every step and Replay (once per run and key).
  for (const key of r.entered) await event(req, run, "entered", key, now);
  for (const a of r.actions) await apply(req, account, run, a, { commentId: o.commentId }, now, out);
  const state: RunState = { ...r.state, ...(firstDm >= 0 || run.state.noted ? { noted: true } : {}) };
  let status: string;
  let nextAt: Date | null = null;
  let reason: string | null = null;
  if (r.done) ({ status, reason } = endOf(r.done.reason));
  else if (state.waiting?.for === "until") {
    status = "waiting";
    nextAt = new Date(state.waiting.until);
  } else if (state.waiting) {
    // Waiting on the person: only while Meta lets the flow answer them. After that the run ends with words.
    status = "waiting";
    nextAt =
      o.privateReplyOnly && o.commentAt
        ? new Date(o.commentAt.getTime() + IG_PRIVATE_REPLY_MS)
        : window.state === "open"
          ? window.until
          : now;
    // A question with "no answer after": looked at again then, even past Meta's window (its No answer steps may only
    // change the lead; a send there stops the run with words, as any send outside the window does).
    if (state.waiting.for === "answer" && state.waiting.until) nextAt = new Date(state.waiting.until);
  } else status = "running";
  await req.db.execute(sql`
    UPDATE instagram_flow_runs
       SET state = ${JSON.stringify(state)}::jsonb, status = ${status}, next_at = ${nextAt}, reason = ${reason},
           updated_at = now()
     WHERE id = ${run.id}`);
  // Go to another flow: this run has ended, so the next can start on the same conversation (one active run each).
  const go = r.actions.find((a): a is Extract<FlowAction, { kind: "goto" }> => a.kind === "goto");
  if (go) await goOn(req, account, run, go.flowId, now, o, out);
}

/** The flow a "Go to another flow" step names starts here, on its live version; never more than GOTO_HOPS in a turn. */
async function goOn(
  req: FastifyRequest,
  account: FlowAccount,
  from: Run,
  flowId: string,
  now: Date,
  o: { privateReplyOnly: boolean; commentId: string | null; commentAt: Date | null },
  out: FlowOut,
) {
  // Counted on the runs themselves, so two flows that send people to each other with a wait between them stop too
  // (a count kept only for one turn started again on every message and every due run: review 2026-11-23).
  const hops = (from.state.chain ?? 0) + 1;
  const problem = (words: string) =>
    recordActivity(req, from.lead_id, "instagram_flow_problem", {
      what: "go to another flow",
      problem: words,
    });
  if (hops > GOTO_HOPS) return problem(FLOW_WORDS.gotoHops);
  const f = (
    await req.db.execute<{ version_id: string }>(sql`
      SELECT live_version_id AS version_id FROM instagram_flows
       WHERE id = ${flowId} AND status = 'live' AND live_version_id IS NOT NULL`)
  ).rows[0];
  if (!f) return problem(FLOW_WORDS.gotoGone);
  // No keyword (the flow wasn't started by one: its numbers stay its own); the automated note, once sent, isn't again.
  const next = await startRun(
    req,
    account,
    { flow_id: flowId, version_id: f.version_id, trigger_id: null },
    null,
    { threadId: from.thread_id, leadId: from.lead_id, via: "goto", now },
    { ...NEW_RUN, chain: hops, ...(from.state.noted ? { noted: true } : {}) },
  );
  if (next) await advance(req, account, next, { kind: "start", via: "dm" }, now, o, out);
}

async function startRun(
  req: FastifyRequest,
  account: FlowAccount,
  c: Pick<Candidate, "flow_id" | "version_id"> & { trigger_id: string | null },
  keyword: string | null,
  p: { threadId: string; leadId: string; via: string; now: Date },
  state: RunState = NEW_RUN,
): Promise<Run | null> {
  const id = newId();
  // One active run per conversation: the partial unique index decides between two deliveries at once.
  const ins = await req.db.execute(sql`
    INSERT INTO instagram_flow_runs (id, flow_id, version_id, trigger_id, thread_id, lead_id, status, state, started_by,
                                     keyword, created_at, updated_at)
    VALUES (${id}, ${c.flow_id}, ${c.version_id}, ${c.trigger_id}, ${p.threadId}, ${p.leadId}, 'running',
            ${JSON.stringify(state)}::jsonb, ${p.via}, ${keyword}, ${p.now}, ${p.now})
    ON CONFLICT DO NOTHING`);
  if (!ins.rowCount) return null;
  const steps = (
    await req.db.execute<{ steps: FlowStep[] | FlowGraph }>(
      sql`SELECT steps FROM instagram_flow_versions WHERE id = ${c.version_id}`,
    )
  ).rows[0]!.steps;
  const run: Run = {
    id,
    flow_id: c.flow_id,
    version_id: c.version_id,
    trigger_id: c.trigger_id,
    thread_id: p.threadId,
    lead_id: p.leadId,
    state,
    keyword,
    started_by: p.via,
    steps,
    flow_status: "live",
  };
  await event(req, run, "triggered", null, p.now);
  return run;
}

/**
 * A person's message (or tap) on a conversation with a lead: it advances the run they're in, or starts the flow it
 * triggers. Called before the message is written to the lead, which is marked with the answer. `first`: the first
 * thing they ever sent this account. Answers the run that took the message (it was said to that flow: Who replied
 * leaves it to the flow), or null.
 */
export async function flowOnMessage(
  req: FastifyRequest,
  account: FlowAccount,
  m: {
    threadId: string;
    leadId: string;
    text: string | null;
    payload: string | null;
    via: "dm" | "story_reply" | "story_mention" | "ad";
    first: boolean;
    adId: string | null;
  },
  now: Date,
  out: FlowOut,
): Promise<string | null> {
  const run = await activeRun(req, m.threadId);
  const held = await heldElsewhere(req, m.threadId, m.leadId);
  if (held) {
    if (run) await stopFlowRuns(req, { threadId: m.threadId }, held);
    return null;
  }
  if (run) {
    if (run.flow_status === "archived") {
      await stopFlowRuns(req, { threadId: m.threadId }, FLOW_WORDS.archived);
      return null;
    }
    // Answered: once per run (the event's own key), whatever the run was waiting on (review 2026-11-23).
    await event(req, run, "replied", "replied", now);
    await advance(
      req,
      account,
      run,
      { kind: "message", text: m.text, payload: m.payload },
      now,
      {
        privateReplyOnly: false,
        commentId: null,
        commentAt: null,
      },
      out,
    );
    return run.id;
  }
  const kinds =
    m.via === "ad" ? ["ad", "dm", "welcome"] : m.via === "dm" ? ["dm", "welcome"] : [m.via, "dm", "welcome"];
  const cands = (await candidates(req, account.id, kinds)).filter((c) => c.kind !== "welcome" || m.first);
  // A story reply or an ad click starts its own flow first; then a DM keyword; then the first-message flow.
  const order = (k: string) => (k === m.via && k !== "dm" ? 0 : k === "dm" ? 1 : 2);
  const hit = pick(cands, m.text, { adId: m.adId, kindOrder: order });
  if (!hit || (await cooling(req, m.threadId, hit.c, now))) return null;
  const started = await startRun(req, account, hit.c, hit.keyword, {
    threadId: m.threadId,
    leadId: m.leadId,
    via: hit.c.kind,
    now,
  });
  if (!started) return null;
  await advance(
    req,
    account,
    started,
    {
      kind: "start",
      via:
        hit.c.kind === "story_reply" || hit.c.kind === "story_mention"
          ? "story"
          : hit.c.kind === "ad"
            ? "ad"
            : hit.c.kind === "welcome"
              ? "welcome"
              : "dm",
    },
    now,
    {
      privateReplyOnly: false,
      commentId: null,
      commentAt: null,
    },
    out,
  );
  return started.id;
}

/**
 * A comment under the account's post or ad: the flow its words trigger starts with its one private reply (and a
 * public reply under the comment, if the trigger has some). The commenter's conversation and lead are made for it,
 * as answering a comment by hand does. Live comments and comments past Meta's 7 days start nothing.
 */
export async function flowOnComment(
  req: FastifyRequest,
  account: FlowAccount,
  c: {
    commentId: string;
    igsid: string;
    username: string | null;
    mediaId: string | null;
    adId: string | null;
    text: string | null;
    live: boolean;
    at: Date;
  },
  now: Date,
  caps: { publicRepliesPerHour: number },
  out: FlowOut,
) {
  if (c.live || !privateReplyOpen({ at: c.at, privateReply: "none" }, now)) return;
  const hit = pick(await candidates(req, account.id, ["comment"]), c.text, {
    mediaId: c.mediaId,
    adId: c.adId,
  });
  if (!hit) return;
  await req.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`instagram:${account.id}:${c.igsid}`}, 0))`,
  );
  const t = (
    await req.db.execute<{ id: string; lead_id: string | null }>(sql`
      INSERT INTO instagram_threads (id, account_id, igsid, username, source)
      VALUES (${newId()}, ${account.id}, ${c.igsid}, ${c.username}, ${JSON.stringify({ trigger: "comment" })}::jsonb)
      ON CONFLICT (account_id, igsid) DO UPDATE SET updated_at = now()
      RETURNING id, lead_id`)
  ).rows[0]!;
  // In this flow within its cool-down: nothing. Already in another run: startRun's unique index refuses a second.
  if (await cooling(req, t.id, hit.c, now)) return;
  let leadId = t.lead_id;
  const live = leadId
    ? (await req.db.execute(sql`SELECT 1 FROM leads WHERE id = ${leadId} AND deleted_at IS NULL`)).rows
        .length > 0
    : false;
  if (!live) {
    // No room for another new lead this hour (a flood of comments): nothing starts; the comment stays kept.
    if (!(await roomForLead(req, account.id, now))) {
      out.held = true;
      return;
    }
    leadId = await createInstagramLead(req, account, {
      username: c.username,
      name: null,
      adId: c.adId,
      how: "comment",
    });
    if (!leadId) {
      await giveBackLead(req, account.id, now);
      return;
    }
    await req.db.execute(sql`UPDATE instagram_threads SET lead_id = ${leadId} WHERE id = ${t.id}`);
  }
  if (await heldElsewhere(req, t.id, leadId!)) return;
  const run = await startRun(req, account, hit.c, hit.keyword, {
    threadId: t.id,
    leadId: leadId!,
    via: "comment",
    now,
  });
  if (!run) return;
  if (!live) await event(req, run, "lead_created", "lead", now);
  if (hit.c.public_replies.length && (await publicRoom(req, account.id, now, caps.publicRepliesPerHour)))
    out.publicReply = {
      commentId: c.commentId,
      text: hit.c.public_replies[Math.floor(Math.random() * hit.c.public_replies.length)]!,
    };
  if (out.publicReply)
    await req.db.execute(
      sql`UPDATE instagram_comments SET public_reply_at = ${now} WHERE comment_id = ${c.commentId}`,
    );
  await advance(
    req,
    account,
    run,
    { kind: "start", via: "comment" },
    now,
    {
      privateReplyOnly: true,
      commentId: c.commentId,
      commentAt: c.at,
    },
    out,
  );
}

/**
 * A run whose time came (a wait ended, or the person didn't answer while Meta allowed a reply): one at a time, under
 * its lock. Called by the minute sweep for each due run.
 */
export async function flowDue(
  req: FastifyRequest,
  account: FlowAccount,
  runId: string,
  now: Date,
  out: FlowOut,
) {
  const r = await req.db.execute<{ thread_id: string }>(sql`
    SELECT thread_id FROM instagram_flow_runs
     WHERE id = ${runId} AND status = 'waiting' AND next_at <= ${now} FOR UPDATE SKIP LOCKED`);
  const threadId = r.rows[0]?.thread_id;
  if (!threadId) return;
  const run = await activeRun(req, threadId);
  if (!run || run.id !== runId) return;
  const held = await heldElsewhere(req, threadId, run.lead_id);
  if (held) {
    await stopFlowRuns(req, { threadId }, held);
    return;
  }
  if (run.flow_status === "archived") {
    await stopFlowRuns(req, { threadId }, FLOW_WORDS.archived);
    return;
  }
  const w = run.state.waiting;
  // A wait's time came, or a question's "no answer after" did: the flow goes on. Anything else waiting on the person
  // past Meta's window ends, as it always has.
  const timed =
    w?.for === "until" || (w?.for === "answer" && !!w.until && now.getTime() >= Date.parse(w.until));
  if (!timed) {
    await req.db.execute(sql`
      UPDATE instagram_flow_runs SET status = 'done', reason = ${FLOW_WORDS.noAnswer}, next_at = NULL, updated_at = now()
       WHERE id = ${runId}`);
    return;
  }
  await advance(
    req,
    account,
    run,
    { kind: "timer", now },
    now,
    { privateReplyOnly: false, commentId: null, commentAt: null },
    out,
  );
}
