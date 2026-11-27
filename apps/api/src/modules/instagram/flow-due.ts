import { can, canOnRecord } from "@lume/core";
import { loadActor } from "../../rbac/actor";
import { jobServer, withJobRequest } from "../imports/job-request";
import { HttpError } from "../../http/errors";
import { allScope } from "../whatsapp/sender";
import { giveToAi } from "./ai-intake";
import { adminIds, notify } from "../notifications/notify";
import { recordActivity } from "../leads/writer";
import { visibleLead } from "../leads/service";
import { createTask, mayManageFor } from "../tasks/service";
import type pg from "pg";
import { FLOW_WORDS, flowDue, newFlowOut, type FlowAccount, type FlowOut } from "./flow-run";
import { igGraph } from "./graph";
import { TryLater } from "./sender";
import type { InstagramJobDeps } from "./process";
import { igGraphOf, igTokenContext } from "./service";

/** How many due runs one sweep takes; the rest wait for the next minute (each is its own short transaction). */
export const FLOW_DUE_BATCH = 500;
/** A step that fails this many times ends its run as failed, with words. */
export const FLOW_STEP_TRIES = 5;

/** Stop one run (and cancel what it had queued) outside any person's request: a background decision. */
async function stopDirect(pool: pg.Pool, runId: string, reason: string) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    await c.query(
      `UPDATE instagram_flow_runs SET status = 'stopped', reason = $2, next_at = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('running', 'waiting')`,
      [runId, reason],
    );
    const q = await c.query<{ comment_id: string | null }>(
      `UPDATE instagram_outbox SET status = 'cancelled', problem = $2, updated_at = now()
        WHERE flow_run_id = $1 AND status = 'queued' RETURNING comment_id`,
      [runId, reason],
    );
    const comments = q.rows.map((r) => r.comment_id).filter((x): x is string => !!x);
    if (comments.length)
      await c.query(
        "UPDATE instagram_comments SET private_reply = 'failed' WHERE comment_id = ANY($1::text[]) AND private_reply = 'queued'",
        [comments],
      );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

type AccountRow = {
  id: string;
  ig_user_id: string;
  username: string;
  owner_user_id: string | null;
  run_as: string;
  source_id: string | null;
  new_dm_creates_lead: boolean;
  automated_note: string | null;
  person_words: string[];
};

export const flowAccountOf = (a: AccountRow): FlowAccount => ({
  id: a.id,
  igUserId: a.ig_user_id,
  username: a.username,
  ownerUserId: a.owner_user_id,
  sourceId: a.source_id,
  newDmCreatesLead: a.new_dm_creates_lead,
  runAs: a.run_as,
  automatedNote: a.automated_note?.trim() || null,
  personWords: a.person_words,
});

/** After a delivery or a due run commits: queue the sends and the public reply, tell whoever was handed a lead. */
export async function afterFlow(o: InstagramJobDeps, out: FlowOut) {
  for (const id of out.sends)
    await o.d.instagram
      ?.enqueueSend(id)
      .catch((err: unknown) => o.app.log.error({ err }, "couldn't queue a flow send"));
  if (out.publicReply)
    await o.d.instagram
      ?.enqueuePublic(out.publicReply.commentId, out.publicReply.text)
      .catch((err: unknown) => o.app.log.warn({ err }, "couldn't queue a public reply"));
  const pool = o.d.jobPool ?? o.d.pool;
  // Hand to LUME AI: the account's standing run takes the lead, as whoever connected the account; when LUME AI can't
  // (off, the month's AI leads used up, the run paused), a person is told, as Hand to a person does. A lead another run
  // holds stays in it (one run per lead).
  for (const t of out.toAi) {
    const actor = await loadActor(pool, t.runAs).catch(() => null);
    const given = actor
      ? await withJobRequest(
          { app: jobServer(o.app), pool, actor, requestId: `instagram-ai:${t.leadId}`, allLeads: true },
          (req) =>
            giveToAi(req, o.d, {
              accountId: t.accountId,
              leadId: t.leadId,
              goal: t.goal,
              answered: t.answered,
            }),
        ).catch((err: unknown) => {
          o.app.log.error({ err }, "couldn't give an Instagram lead to LUME AI");
          return null;
        })
      : null;
    if (given && given !== "held") await o.d.autopilot?.kick(given.runId).catch(() => undefined);
    else if (!given && t.notice) out.notices.push(t.notice);
  }
  for (const n of out.notices)
    await notify(pool, n.ownerId, {
      kind: "lead_replied",
      title: n.title,
      body: n.body,
      leadId: n.leadId,
    }).catch((err: unknown) => o.app.log.warn({ err }, "couldn't tell someone a flow passed them a lead"));
  // "Tell my team" to the admins: whoever they are now.
  if (out.adminNotices.length) {
    const admins = await adminIds(pool).catch(() => [] as string[]);
    for (const n of out.adminNotices)
      for (const uid of admins)
        await notify(pool, uid, {
          kind: "lead_replied",
          title: n.title,
          body: n.body,
          leadId: n.leadId,
        }).catch((err: unknown) => o.app.log.warn({ err }, "couldn't tell an admin what a flow said"));
  }
  for (const n of out.userNotices) {
    const who = await loadActor(pool, n.userId).catch(() => null);
    if (!who) continue;
    const sees = canOnRecord(who, "leads.view", n.leadOwner);
    await notify(
      pool,
      n.userId,
      sees
        ? { kind: "lead_replied", title: n.title, body: n.body, leadId: n.leadId }
        : { kind: "lead_replied", title: "A lead on Instagram", body: n.body },
    ).catch((err: unknown) => o.app.log.warn({ err }, "couldn't tell someone what a flow said"));
  }
  // A flow's follow-ups, made as the account's run-as person would make them: for the lead's owner when that person
  // may give them follow-ups, else their own. One that can't be made is noted on the lead; the delivery stands.
  for (const t of out.tasks) {
    const actor = await loadActor(pool, t.runAs).catch(() => null);
    if (!actor) {
      // Whoever connected the account is gone: noted on the lead, never lost without a word.
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
        await c.query(
          "INSERT INTO activities (id, lead_id, type, payload) VALUES (gen_random_uuid(), $1, 'instagram_flow_problem', $2)",
          [
            t.leadId,
            JSON.stringify({
              what: "follow-up",
              problem: "Whoever connected Instagram no longer uses LUME.",
            }),
          ],
        );
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        o.app.log.warn({ err }, "couldn't note a flow's follow-up that wasn't made");
      } finally {
        c.release();
      }
      continue;
    }

    const job = {
      app: jobServer(o.app),
      pool,
      actor,
      requestId: `instagram-flow-task:${t.leadId}`,
      allLeads: true,
    };
    try {
      await withJobRequest(job, async (req) => {
        const lead = await visibleLead(req, t.leadId);
        const assigneeId = lead.ownerId && mayManageFor(actor, lead.ownerId) ? lead.ownerId : actor.userId;
        const at = new Date(o.d.clock().getTime() + t.dueMinutes * 60_000).toISOString();
        await createTask(req, o.d, t.leadId, { title: t.title, due: { at }, assigneeId });
      });
    } catch (err) {
      o.app.log.warn({ err }, "couldn't make a flow's follow-up");
      await withJobRequest(job, (req) =>
        recordActivity(req, t.leadId, "instagram_flow_problem", {
          what: "follow-up",
          problem: err instanceof HttpError ? err.message : "LUME couldn't make it.",
        }),
      ).catch(() => undefined);
    }
  }
}

/**
 * Runs whose time came (a wait ended, or the person didn't answer while Meta allowed it), oldest first, each in its
 * own transaction as its account's run_as. Answers how many it looked at. Called every minute.
 */
export async function runDueFlows(o: InstagramJobDeps): Promise<number> {
  const pool = o.d.jobPool ?? o.d.pool;
  const now = o.d.clock();
  const c = await pool.connect();
  let due: { id: string; account: AccountRow & { status: string } }[];
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const r = await c.query<{ id: string; account: AccountRow & { status: string } }>(
      `SELECT r.id, row_to_json(a.*) AS account
         FROM instagram_flow_runs r
         JOIN instagram_threads t ON t.id = r.thread_id
         JOIN instagram_accounts a ON a.id = t.account_id
        WHERE r.status = 'waiting' AND r.next_at <= $1
        ORDER BY r.next_at LIMIT $2`,
      [now, FLOW_DUE_BATCH],
    );
    await c.query("COMMIT");
    due = r.rows;
  } finally {
    c.release();
  }
  for (const { id, account } of due) {
    // A run that can't go on stops with words (never left at the head of every sweep, holding others back).
    const actor = await loadActor(pool, account.run_as);
    const blocked =
      account.status === "disconnected"
        ? FLOW_WORDS.accountGone
        : !actor || !can(actor, "leads.view")
          ? FLOW_WORDS.cantRun
          : account.status !== "active"
            ? null // needs connecting again: it waits, and the delivery side tells the admins
            : undefined;
    if (blocked === null) continue;
    if (blocked) {
      await stopDirect(pool, id, blocked);
      continue;
    }
    const out = newFlowOut();
    try {
      await withJobRequest(
        { app: jobServer(o.app), pool, actor: actor!, requestId: `instagram-flow:${id}`, allLeads: true },
        (req) => flowDue(req, flowAccountOf(account), id, now, out),
      );
      await afterFlow(o, out);
    } catch (err) {
      o.app.log.error({ err, run: id }, "an Instagram flow step failed");
      // Counted: the fifth failure ends the run with the fault's kind (never its message, which may quote words).
      const kind = err instanceof Error ? err.name : "Error";
      await pool
        .query(
          `UPDATE instagram_flow_runs SET tries = tries + 1,
                  status = CASE WHEN tries + 1 >= $2 THEN 'failed' ELSE status END,
                  reason = CASE WHEN tries + 1 >= $2 THEN $3 ELSE reason END,
                  next_at = CASE WHEN tries + 1 >= $2 THEN NULL ELSE next_at END
            WHERE id = $1`,
          [id, FLOW_STEP_TRIES, `LUME couldn't run this step (${kind}).`],
        )
        .catch(() => undefined);
    }
  }
  return due.length;
}

/** The public reply under a comment (best effort: Meta refusing it changes nothing else), at the account's pace. */
export async function sendPublicReply(
  o: InstagramJobDeps & { pacer: { take(accountId: string): boolean } },
  commentId: string,
  text: string,
) {
  const pool = o.d.jobPool ?? o.d.pool;
  // A job sees every comment (row-level security shows a comment only to its account's people otherwise): read
  // without it, every flow's public reply was "gone" and never went (found 2026-11-27).
  const { rows } = await allScope(pool, (c) =>
    c.query<{ id: string; token_enc: Buffer | null }>(
      `SELECT a.id, a.token_enc FROM instagram_comments c JOIN instagram_accounts a ON a.id = c.account_id
        WHERE c.comment_id = $1 AND a.status = 'active'`,
      [commentId],
    ),
  );
  const a = rows[0];
  if (!a?.token_enc) return "gone" as const;
  if (!o.pacer.take(a.id)) throw new TryLater("the account's calls for this second are used");
  const token = o.d.keyring.decrypt(a.token_enc, igTokenContext(a.id));
  const r = await igGraph(igGraphOf(o.d), token).publicReply(commentId, text);
  // Meta busy or rate-limiting: the queue tries again; any other refusal is final.
  if (!r.ok && (r.status === 0 || r.status === 429 || r.status >= 500))
    throw new Error("Meta busy; public reply later");
  if (r.ok) {
    await allScope(pool, (c) =>
      c.query("UPDATE instagram_comments SET public_reply_id = $2 WHERE comment_id = $1", [
        commentId,
        typeof r.data.id === "string" ? r.data.id : null,
      ]),
    );
    return "sent" as const;
  }
  // Refused: no reply under it, so a person can still answer it publicly from LUME.
  await allScope(pool, (c) =>
    c.query(
      "UPDATE instagram_comments SET public_reply_at = NULL WHERE comment_id = $1 AND public_reply IS NULL",
      [commentId],
    ),
  );
  return "refused" as const;
}
