import {
  canOnRecord,
  moduleIncluded,
  igOutboundBody,
  instagramWindow,
  messageProblems,
  privateReplyOpen,
  refusalOfIg,
} from "@lume/core";
import type pg from "pg";
import { HttpError } from "../../http/errors";
import { loadActor } from "../../rbac/actor";
import { jobServer, withJobRequest } from "../imports/job-request";
import { countSend } from "../leads/sending";
import { visibleLead } from "../leads/service";
import { recordActivity } from "../leads/writer";
import { igGraph } from "./graph";
import type { InstagramJobDeps } from "./process";
import { igGraphOf, igTokenContext } from "./service";
import { tokenRefused } from "./token-refresh";

/** A message "sending" this long is a crash mid-send: it's failed with words, never sent again by itself. */
export const IG_SENDING_STUCK_MS = 10 * 60_000;
export const IG_SEND_TRIES = 8;
export const IG_SEND_RETRY_DELAY_S = 20;
export const IG_MAYBE_SENT = "LUME couldn't tell whether this went. Check Instagram before sending it again.";

/** Thrown to have the queue try this message again later (Meta busy, the account's pace reached). */
export class TryLater extends Error {}

/**
 * Each account's pace, kept below Meta's (100 calls a second for text, 750 private replies an hour): a send over it
 * waits for the queue's next try, never fails. Seconds are counted here, in this process (one API per LUME); the
 * hour's private replies are counted in the database, so a restart never resets them.
 */
export function igPacer(o: { now: () => Date; perSecond: number }) {
  const sent = new Map<string, number[]>();
  return {
    take(accountId: string): boolean {
      const t = o.now().getTime();
      const recent = (sent.get(accountId) ?? []).filter((x) => t - x < 1000);
      if (recent.length >= o.perSecond) {
        sent.set(accountId, recent);
        return false;
      }
      recent.push(t);
      sent.set(accountId, recent);
      if (sent.size > 10_000) sent.delete(sent.keys().next().value!);
      return true;
    },
  };
}
export type IgPacer = ReturnType<typeof igPacer>;

export type IgSendDeps = InstagramJobDeps & {
  pacer: IgPacer;
  privateRepliesPerHour: number;
  testHooks?: { beforeClaim?: () => Promise<void> };
};

async function allScope<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

type Row = {
  status: string;
  stuck: boolean;
  tries: number;
  kind: "dm" | "private_reply";
  text: string | null;
  quick_replies: { title: string; payload: string }[] | null;
  buttons: { title: string; url: string }[] | null;
  tag: string | null;
  flow_run_id: string | null;
  autopilot_run_id: string | null;
  allow_after_dnc: boolean;
  /** LUME AI's run and its lead, as they are now (null for a person's or a flow's message). */
  run_status: string | null;
  run_lead_active: boolean | null;
  run_lead_state: string | null;
  step_key: string | null;
  user_id: string;
  user_name: string | null;
  lead_id: string;
  thread_id: string;
  lead_deleted: boolean;
  lead_dnc: boolean;
  lead_name: string;
  igsid: string;
  last_in_at: Date | string | null;
  ad_window_until: Date | string | null;
  account_id: string;
  ig_user_id: string;
  account_status: string;
  token_enc: Buffer | null;
  comment_id: string | null;
  comment_at: Date | string | null;
  comment_state: "none" | "queued" | "sent" | "failed" | null;
  taken_over: boolean;
};
const at = (v: Date | string | null) => (v === null ? null : new Date(v));

/** The next message to the same person, if one waits behind this one: woken now. */
async function wakeNext(o: IgSendDeps, threadId: string) {
  const pool = o.d.jobPool ?? o.d.pool;
  const next = await allScope(
    pool,
    async (c) =>
      (
        await c.query<{ id: string }>(
          `SELECT id FROM instagram_outbox WHERE thread_id = $1 AND status = 'queued' ORDER BY created_at, id LIMIT 1`,
          [threadId],
        )
      ).rows[0],
  );
  if (next) await o.d.instagram?.enqueueSend(next.id).catch(() => undefined);
}

/**
 * One message to Meta (NEW_FEATURES_PLAN §4.4, §6), as the person who sent it, in order per conversation. Just before
 * Meta, every rule is checked again: the lead is here and not do not contact, the sender may still message it, the
 * account is connected, Meta's window (or the comment's one private reply) still allows it, and the account's pace has
 * room. A message Meta takes is a send (first contact, the follow-up's move); one Meta refuses says why in words; one
 * whose answer was lost is failed with words and never sent again by itself.
 */
export async function sendInstagramOutbox(o: IgSendDeps, id: string): Promise<void> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  const row = await allScope(
    pool,
    async (c) =>
      (
        await c.query<Row>(
          `SELECT o.status, o.updated_at < now() - make_interval(secs => $2) AS stuck, o.tries, o.kind, o.text,
                  o.quick_replies, o.buttons, o.tag, o.flow_run_id, o.step_key, o.user_id, u.name AS user_name, o.lead_id, o.thread_id,
                  o.autopilot_run_id, o.allow_after_dnc, ar.status AS run_status, al.active AS run_lead_active,
                  al.state AS run_lead_state,
                  l.deleted_at IS NOT NULL AS lead_deleted, l.dnc_at IS NOT NULL AS lead_dnc, l.name AS lead_name,
                  t.igsid, t.last_in_at, t.ad_window_until, a.id AS account_id, a.ig_user_id, a.status AS account_status,
                  a.token_enc, o.comment_id, c.at AS comment_at, c.private_reply AS comment_state,
                  t.taken_over_by IS NOT NULL AS taken_over
             FROM instagram_outbox o
             JOIN leads l ON l.id = o.lead_id
             JOIN instagram_threads t ON t.id = o.thread_id
             JOIN instagram_accounts a ON a.id = o.account_id
             LEFT JOIN users u ON u.id = o.user_id
             LEFT JOIN instagram_comments c ON c.comment_id = o.comment_id
             LEFT JOIN autopilot_runs ar ON ar.id = o.autopilot_run_id
             LEFT JOIN autopilot_leads al ON al.run_id = o.autopilot_run_id AND al.lead_id = o.lead_id
            WHERE o.id = $1`,
          [id, IG_SENDING_STUCK_MS / 1000],
        )
      ).rows[0],
  );
  if (!row) return;
  const set = (status: string, f: { problem?: string | null; mid?: string; tries?: number } = {}) =>
    allScope(pool, async (c) => {
      await c.query(
        `UPDATE instagram_outbox SET status = $2, problem = $3, mid = coalesce($4, mid), tries = coalesce($5, tries),
                updated_at = now() WHERE id = $1`,
        [id, status, f.problem ?? null, f.mid ?? null, f.tries ?? null],
      );
      // A private reply that didn't go leaves the comment's one reply free again (while its 7 days last).
      if (row.kind === "private_reply" && (status === "failed" || status === "cancelled"))
        await c.query(
          "UPDATE instagram_comments SET private_reply = 'failed' WHERE comment_id = $1 AND private_reply = 'queued'",
          [row.comment_id],
        );
      // A flow's message that didn't go isn't one it sent: its count in the flow's numbers goes with it.
      if (row.flow_run_id && (status === "failed" || status === "cancelled"))
        await c.query(
          `DELETE FROM instagram_flow_events
            WHERE run_id = $1 AND step_key = $2 AND kind IN ('dm_sent', 'private_reply')`,
          [row.flow_run_id, row.step_key],
        );
    });
  const fail = async (problem: string) => {
    await set("failed", { problem });
    await wakeNext(o, row.thread_id);
  };
  if (row.status === "sending") {
    if (row.stuck) await fail(IG_MAYBE_SENT);
    return;
  }
  if (row.status !== "queued") return;
  if (row.lead_deleted) return void (await fail("This lead isn't here any more."));
  if (row.lead_dnc && !row.allow_after_dnc) {
    await set("cancelled", { problem: `${row.lead_name || "This lead"} asked not to be messaged.` });
    return void (await wakeNext(o, row.thread_id));
  }
  // Switched off, or out of the plan, since it was queued: nothing more goes.
  const on = await pool.query<{ on: boolean }>(
    "SELECT coalesce((integrations -> 'instagram' ->> 'enabled')::boolean, false) AS on FROM settings WHERE id = 1",
  );
  if (!on.rows[0]?.on) return void (await fail("Instagram was switched off before this went."));
  if (!moduleIncluded(o.app.licence.view().plan, "instagram"))
    return void (await fail("Instagram left this LUME's plan before this went."));
  if ((row.flow_run_id || row.autopilot_run_id) && row.taken_over)
    return void (await fail("A person took this conversation over before this went."));
  // LUME AI's: paused, ended, or the lead no longer LUME AI's since it was queued: never sent (as WhatsApp's).
  if (
    row.autopilot_run_id &&
    !row.allow_after_dnc &&
    (row.run_status !== "running" ||
      !row.run_lead_active ||
      row.run_lead_state === "with_you" ||
      row.run_lead_state === "stopped")
  ) {
    await set("cancelled", { problem: "LUME AI's run was paused before this went." });
    return void (await wakeNext(o, row.thread_id));
  }
  if (row.account_status !== "active" || !row.token_enc)
    return void (await fail("This Instagram account needs connecting again before LUME can send from it."));
  const problems = messageProblems({
    text: row.text,
    quickReplies: row.quick_replies ?? [],
    buttons: row.buttons ?? [],
  });
  if (problems.length) return void (await fail(problems[0]!));

  // Meta's rules, now (not when it was queued).
  const now = d.clock();
  let tag: "HUMAN_AGENT" | undefined;
  if (row.kind === "private_reply") {
    if (!row.comment_at || !privateReplyOpen({ at: new Date(row.comment_at), privateReply: "none" }, now))
      return void (await fail("Instagram allows a private reply only within 7 days of the comment."));
  } else {
    const w = instagramWindow({ lastInAt: at(row.last_in_at), adWindowUntil: at(row.ad_window_until) }, now);
    // Past the 24 hours only a person may answer (Meta's human agent tag): never a flow, never LUME AI.
    if (w.state === "closed" || (w.state === "human" && (row.flow_run_id || row.autopilot_run_id)))
      return void (await fail(
        "Instagram's time to reply ran out before this went. LUME can send again once they write.",
      ));
    // After 24 hours, a person's reply goes with Meta's human agent tag (never a flow's).
    if (w.state === "human") tag = "HUMAN_AGENT";
  }

  // The sender, as they are now: someone who can't message this lead any more doesn't send to it.
  const actor = await loadActor(pool, row.user_id);
  const lost = `${row.user_name?.trim() || "This person"} can't message this lead any more.`;
  if (!actor) return void (await fail(lost));
  const allowed = await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `instagram-send:${id}`, allLeads: false },
    async (req) => {
      const lead = await visibleLead(req, row.lead_id).catch((e: unknown) => {
        if (e instanceof HttpError) return null;
        throw e;
      });
      return !!lead && canOnRecord(actor, "messages.send", lead.ownerId);
    },
  );
  if (!allowed) return void (await fail(lost));

  // The account's pace: over it, the message waits for the queue's next try.
  if (row.kind === "private_reply") {
    const n = await allScope(
      pool,
      async (c) =>
        (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM instagram_outbox
              WHERE account_id = $1 AND kind = 'private_reply' AND status IN ('sending', 'sent', 'read')
                AND updated_at > now() - interval '1 hour'`,
            [row.account_id],
          )
        ).rows[0]!.n,
    );
    if (n >= o.privateRepliesPerHour)
      throw new TryLater("the account's private replies for this hour are used");
  }
  if (!o.pacer.take(row.account_id)) throw new TryLater("the account's sends for this second are used");

  await o.testHooks?.beforeClaim?.();
  const tries = row.tries + 1;
  // Taken only when nothing to this person before it is still on its way, and only while the lead is still here and
  // not do not contact (checked again in the same statement that claims it).
  const claimed = await allScope(pool, (c) =>
    c.query(
      `UPDATE instagram_outbox o SET status = 'sending', tries = $2, problem = NULL, updated_at = now()
        WHERE o.id = $1 AND o.status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM instagram_outbox e
                           WHERE e.thread_id = o.thread_id AND e.id <> o.id AND e.status IN ('queued', 'sending')
                             AND (e.created_at, e.id) < (o.created_at, o.id))
          AND EXISTS (SELECT 1 FROM leads l WHERE l.id = o.lead_id AND l.deleted_at IS NULL
                                                 AND (l.dnc_at IS NULL OR o.allow_after_dnc))
          -- A flow's or LUME AI's message never goes into a conversation a person has taken over since it was queued.
          AND ((o.flow_run_id IS NULL AND o.autopilot_run_id IS NULL) OR NOT EXISTS (
            SELECT 1 FROM instagram_threads t WHERE t.id = o.thread_id AND t.taken_over_by IS NOT NULL))
          -- LUME AI's: its run still running and the lead still LUME AI's (its one apology for a stop aside).
          AND (o.autopilot_run_id IS NULL OR o.allow_after_dnc OR EXISTS (
            SELECT 1 FROM autopilot_runs ar
              JOIN autopilot_leads al ON al.run_id = ar.id AND al.lead_id = o.lead_id
             WHERE ar.id = o.autopilot_run_id AND ar.status = 'running' AND al.active
               AND al.state NOT IN ('with_you', 'stopped')))`,
      [id, tries],
    ),
  );
  if (!claimed.rowCount) return; // an older one to this person goes first; it wakes this one when it's done
  const target = row.kind === "private_reply" ? { commentId: row.comment_id! } : { igsid: row.igsid };
  const body = igOutboundBody(
    target,
    { text: row.text, quickReplies: row.quick_replies ?? [], buttons: row.buttons ?? [] },
    tag,
  );
  const r = await igGraph(
    igGraphOf(d),
    d.keyring.decrypt(row.token_enc, igTokenContext(row.account_id)),
  ).send(row.ig_user_id, body);
  const mid = typeof r.data.message_id === "string" ? r.data.message_id : null;
  const code = (r.data.error as { code?: unknown } | undefined)?.code;
  if (!r.ok || !mid) {
    // Handed to Meta with no clear answer (unreachable, a 5xx without Meta's error, a body without an id): it may
    // have gone. Never again by itself.
    if (r.status === 0 || (r.ok && !mid) || (r.status >= 500 && typeof code !== "number")) {
      o.app.log.warn({ outbox: id, status: r.status }, "instagram send unclear");
      return void (await fail(IG_MAYBE_SENT));
    }
    const why = refusalOfIg(r.status, r.data);
    if (why.token) {
      await tokenRefused(pool, row.account_id);
      return void (await fail(why.words));
    }
    if (why.retry && tries < IG_SEND_TRIES) {
      await set("queued", { tries });
      throw new TryLater(why.code);
    }
    // Meta's error code only: never its message text, which can quote the request.
    o.app.log.warn({ outbox: id, code }, "instagram send refused");
    return void (await fail(why.words));
  }

  // Meta took it: sent, with Meta's id (an echo of it is matched by that), kept on its own first so the bookkeeping
  // below failing never undoes "sent".
  await allScope(pool, async (c) => {
    await c.query(
      `UPDATE instagram_outbox SET status = 'sent', mid = $2, problem = NULL, updated_at = now()
        WHERE id = $1 AND status = 'sending'`,
      [id, mid],
    );
    // LUME's own clock, as Meta's times for their messages are read against it (who wrote last: LUME AI's hand back).
    const sentAt = d.clock();
    await c.query(
      `UPDATE instagram_threads SET last_out_at = $2, last_message_at = GREATEST(coalesce(last_message_at, $2), $2)
        WHERE id = $1`,
      [row.thread_id, sentAt],
    );
    if (row.kind === "private_reply")
      await c.query(
        "UPDATE instagram_comments SET private_reply = 'sent', private_reply_at = now() WHERE comment_id = $1",
        [row.comment_id],
      );
  });
  // Then it counts as a send, as the person who sent it: first contact, the stage's move on a send.
  await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `instagram-sent:${id}`, allLeads: true },
    async (req) => {
      const lead = await visibleLead(req, row.lead_id);
      await recordActivity(req, lead.id, "instagram_confirmed_sent", {
        // Who answered, for Analytics: a flow, LUME AI, or a person from LUME.
        via: row.flow_run_id ? "flow" : row.autopilot_run_id ? "ai" : "lume",
        outboxId: id,
        threadId: row.thread_id,
      });
      await countSend(req, d, lead, undefined);
    },
  ).catch((err: unknown) =>
    o.app.log.warn({ err, outbox: id }, "a sent Instagram message couldn't be counted"),
  );
  await wakeNext(o, row.thread_id);
}
