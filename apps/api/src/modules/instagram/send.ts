import {
  can,
  canOnRecord,
  instagramWindow,
  messageProblems,
  moduleIncluded,
  newId,
  privateReplyOpen,
} from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { HttpError, badRequest, forbidden, notFound } from "../../http/errors";
import { sendable } from "../leads/sending";
import { visibleLead } from "../leads/service";
import type { SendLimiter } from "../whatsapp/send";
import { createInstagramLead } from "./leads";
import { instagramOn } from "./service";

const conflict = (code: string, message: string) => new HttpError(409, code, message);
const when = (d: Date) =>
  d.toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });

async function requireInstagram(req: FastifyRequest) {
  if (!(await instagramOn(req)) || !moduleIncluded(req.server.licence.view().plan, "instagram"))
    throw conflict(
      "INSTAGRAM_OFF",
      "Instagram is switched off. An admin can switch it on in Settings → Integrations.",
    );
}

type ThreadRow = {
  id: string;
  lead_id: string | null;
  account_id: string;
  account_status: string;
  last_in_at: Date | string | null;
  ad_window_until: Date | string | null;
};
const at = (v: Date | string | null) => (v === null ? null : new Date(v));

/** The conversation, on this lead, locked for this send. */
async function threadOn(req: FastifyRequest, leadId: string, threadId: string): Promise<ThreadRow> {
  const r = await req.db.execute<ThreadRow>(sql`
    SELECT t.id, t.lead_id, t.account_id, a.status AS account_status, t.last_in_at, t.ad_window_until
      FROM instagram_threads t JOIN instagram_accounts a ON a.id = t.account_id
     WHERE t.id = ${threadId} AND t.lead_id = ${leadId} FOR UPDATE OF t`);
  const t = r.rows[0];
  if (!t) throw notFound("THREAD_NOT_FOUND", "That Instagram conversation isn't on this lead.");
  if (t.account_status !== "active")
    throw conflict(
      "ACCOUNT_NOT_READY",
      "This Instagram account needs connecting again before LUME can send from it.",
    );
  return t;
}

/** A person writing in a conversation takes it over: flows and LUME AI stop for it until someone hands it back. */
async function takeOver(req: FastifyRequest, threadId: string) {
  await req.db.execute(sql`
    UPDATE instagram_threads SET taken_over_by = coalesce(taken_over_by, ${req.actor!.userId}::uuid),
           taken_over_at = coalesce(taken_over_at, now()), updated_at = now()
     WHERE id = ${threadId}`);
}

/** One message as the thread shows it (thread.ts's shape). */
async function viewOf(req: FastifyRequest, outboxId: string) {
  const r = await req.db.execute<{
    id: string;
    created_at: Date | string;
    text: string | null;
    status: string;
    problem: string | null;
    tag: string | null;
    user_id: string;
    user_name: string;
    quick_replies: unknown;
    kind: string;
  }>(sql`
    SELECT o.id, o.created_at, o.text, o.status, o.problem, o.tag, o.user_id, u.name AS user_name, o.quick_replies, o.kind
      FROM instagram_outbox o JOIN users u ON u.id = o.user_id WHERE o.id = ${outboxId}`);
  const o = r.rows[0]!;
  return {
    id: o.id,
    direction: "out" as const,
    at: new Date(o.created_at).toISOString(),
    text: o.text,
    detail: Array.isArray(o.quick_replies) ? { quickReplies: o.quick_replies } : {},
    unsent: false,
    sentBy: { id: o.user_id, name: o.user_name },
    status: o.status,
    problem: o.problem,
    reaction: null,
    outboxId: o.id,
    fromPhone: false,
    humanAgent: o.tag === "human_agent",
    privateReply: o.kind === "private_reply",
  };
}

/**
 * The same key from the same person again (a double tap, a retried request, a second tab) is the first message, never a
 * second; on another lead it's refused.
 */
async function prior(req: FastifyRequest, clientKey: string, leadId: string) {
  const r = await req.db.execute<{ id: string; lead_id: string }>(sql`
    SELECT id, lead_id FROM instagram_outbox WHERE user_id = ${req.actor!.userId} AND client_key = ${clientKey}`);
  const p = r.rows[0];
  if (!p) return null;
  if (p.lead_id !== leadId) throw badRequest("KEY_REUSED", "That message was already sent to another lead.");
  return { message: await viewOf(req, p.id) };
}

/** Insert under a savepoint: the same key arriving twice at once is one message (the second finds the first). */
async function insertOnce(
  req: FastifyRequest,
  clientKey: string,
  leadId: string,
  write: () => Promise<unknown>,
): Promise<{ message: Awaited<ReturnType<typeof viewOf>> } | null> {
  await req.db.execute(sql`SAVEPOINT lume_ig_send`);
  try {
    await write();
    await req.db.execute(sql`RELEASE SAVEPOINT lume_ig_send`);
    return null;
  } catch (e) {
    await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_ig_send`);
    if ((e as { code?: string }).code !== "23505") throw e;
    const first = await prior(req, clientKey, leadId);
    if (first) return first;
    throw e;
  }
}

/**
 * A person's reply on Instagram from LUME (NEW_FEATURES_PLAN §4.4, §4.6): inside Meta's 24 hours as is; after them and
 * within 7 days of the person's last message, with Meta's human agent tag (a person's only); after that, not at all,
 * and LUME says from when. Checked again just before Meta. The person takes the conversation over.
 */
export async function sendInstagram(
  req: FastifyRequest,
  d: AppDeps,
  limiter: SendLimiter,
  leadId: string,
  body: {
    clientKey: string;
    threadId: string;
    text: string;
    quickReplies?: { title: string; payload: string }[] | undefined;
    retryOf?: string | undefined;
  },
) {
  const again = await prior(req, body.clientKey, leadId);
  if (again) return again;
  await requireInstagram(req);
  const lead = await sendable(req, leadId);
  const t = await threadOn(req, lead.id, body.threadId);
  const problems = messageProblems({ text: body.text, quickReplies: body.quickReplies ?? [] });
  if (problems.length) throw badRequest("MESSAGE_INVALID", problems[0]!, { problems });
  const w = instagramWindow({ lastInAt: at(t.last_in_at), adWindowUntil: at(t.ad_window_until) }, d.clock());
  if (w.state === "closed")
    throw conflict(
      "WINDOW_CLOSED",
      w.since
        ? `Instagram only lets a business reply within 7 days of the person's last message, and that ended ${when(w.since)}. LUME can send again once they write.`
        : "This person hasn't written to you on Instagram, so LUME can't message them there. Instagram allows a reply only after they write.",
    );
  const verdict = limiter.take(req.actor!.userId);
  if (!verdict.ok)
    throw new HttpError(429, "TOO_MANY", "That's a lot of messages at once. Wait a minute and send again.", {
      retryAfterSec: verdict.retryAfterSec,
    });
  // Try again: only a failed message, claimed under a lock, so two tabs send one copy.
  if (body.retryOf) {
    const was = (
      await req.db.execute<{ status: string; lead_id: string }>(sql`
        SELECT status, lead_id FROM instagram_outbox WHERE id = ${body.retryOf} FOR UPDATE`)
    ).rows[0];
    if (was?.lead_id === lead.id && was.status === "cancelled")
      throw conflict("ALREADY_SENT_AGAIN", "This message was already sent again.");
    if (!was || was.lead_id !== lead.id || was.status !== "failed")
      throw badRequest("NOT_RETRYABLE", "Only a message that didn't go can be sent again.");
    await req.db.execute(
      sql`UPDATE instagram_outbox SET status = 'cancelled', updated_at = now() WHERE id = ${body.retryOf}`,
    );
  }
  const id = newId();
  const raced = await insertOnce(req, body.clientKey, lead.id, () =>
    req.db.execute(sql`
      INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, text, quick_replies, tag, status)
      VALUES (${id}, ${t.id}, ${lead.id}, ${t.account_id}, ${req.actor!.userId}, ${body.clientKey}, 'dm', ${body.text},
              ${body.quickReplies?.length ? JSON.stringify(body.quickReplies) : null}::jsonb,
              ${w.state === "human" ? "human_agent" : null}, 'queued')`),
  );
  if (raced) return raced;
  await takeOver(req, t.id);
  req.afterCommit(() => void d.instagram?.enqueueSend(id));
  return { message: await viewOf(req, id) };
}

/**
 * The one private reply Meta allows to a comment, within 7 days of it (NEW_FEATURES_PLAN §4.4). The commenter's
 * conversation is made if it isn't yet, and their lead with it (a person who may add leads); one already on a lead the
 * person can't message is refused as missing.
 */
export async function privateReply(
  req: FastifyRequest,
  d: AppDeps,
  limiter: SendLimiter,
  commentId: string,
  body: { clientKey: string; text: string },
) {
  await requireInstagram(req);
  const c = (
    await req.db.execute<{
      id: string;
      comment_id: string;
      account_id: string;
      from_igsid: string;
      from_username: string | null;
      at: Date | string;
      private_reply: "none" | "queued" | "sent" | "failed";
      thread_id: string | null;
      live: boolean;
      ad_id: string | null;
    }>(sql`
      SELECT id, comment_id, account_id, from_igsid, from_username, at, private_reply, thread_id, live, ad_id
        FROM instagram_comments WHERE id = ${commentId} FOR UPDATE`)
  ).rows[0];
  if (!c) throw notFound("COMMENT_NOT_FOUND", "That comment isn't here.");
  // The same tap again (a double click, a retried request) is the reply already queued, not a refusal.
  const mine = (
    await req.db.execute<{ id: string; comment_id: string | null }>(sql`
      SELECT id, comment_id FROM instagram_outbox WHERE user_id = ${req.actor!.userId} AND client_key = ${body.clientKey}`)
  ).rows[0];
  if (mine && mine.comment_id === c.comment_id) return { message: await viewOf(req, mine.id) };
  if (mine) throw badRequest("KEY_REUSED", "That message was already sent somewhere else.");
  if (c.live)
    throw conflict("LIVE_COMMENT", "Instagram lets a business answer a live comment only during the live.");
  if (!privateReplyOpen({ at: new Date(c.at), privateReply: c.private_reply }, d.clock()))
    throw conflict(
      "PRIVATE_REPLY_USED",
      c.private_reply === "sent" || c.private_reply === "queued"
        ? "Instagram allows one private reply to a comment, and this one has it."
        : "Instagram allows a private reply only within 7 days of the comment.",
    );
  const problems = messageProblems({ text: body.text });
  if (problems.length) throw badRequest("MESSAGE_INVALID", problems[0]!, { problems });

  // The commenter's conversation and lead.
  const acct = (
    await req.db.execute<{
      id: string;
      ig_user_id: string;
      username: string;
      owner_user_id: string | null;
      source_id: string | null;
      new_dm_creates_lead: boolean;
      status: string;
    }>(sql`SELECT * FROM instagram_accounts WHERE id = ${c.account_id}`)
  ).rows[0]!;
  if (acct.status !== "active")
    throw conflict(
      "ACCOUNT_NOT_READY",
      "This Instagram account needs connecting again before LUME can send from it.",
    );
  await req.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`instagram:${c.account_id}:${c.from_igsid}`}, 0))`,
  );
  let t = (
    await req.db.execute<{ id: string; lead_id: string | null }>(sql`
      SELECT id, lead_id FROM instagram_threads WHERE account_id = ${c.account_id} AND igsid = ${c.from_igsid}`)
  ).rows[0];
  let leadId = t?.lead_id ?? null;
  if (leadId) {
    const lead = await visibleLead(req, leadId);
    if (!canOnRecord(req.actor!, "messages.send", lead.ownerId)) throw forbidden();
  } else {
    if (!can(req.actor!, "leads.create"))
      throw forbidden(
        "LEAD_NEEDED",
        "Answering this comment makes its writer a lead. Ask someone who may add leads.",
      );
    leadId = await createInstagramLead(
      req,
      {
        id: acct.id,
        igUserId: acct.ig_user_id,
        username: acct.username,
        ownerUserId: acct.owner_user_id,
        sourceId: acct.source_id,
        newDmCreatesLead: acct.new_dm_creates_lead,
      },
      { username: c.from_username, name: null, adId: c.ad_id, how: "comment" },
    );
    if (!leadId) throw conflict("NO_PIPELINE", "LUME needs a pipeline with an open stage first.");
    if (!t) {
      const id = newId();
      await req.db.execute(sql`
        INSERT INTO instagram_threads (id, account_id, igsid, lead_id, username, source)
        VALUES (${id}, ${c.account_id}, ${c.from_igsid}, ${leadId}, ${c.from_username},
                ${JSON.stringify({ trigger: "comment" })}::jsonb)`);
      t = { id, lead_id: leadId };
    } else await req.db.execute(sql`UPDATE instagram_threads SET lead_id = ${leadId} WHERE id = ${t.id}`);
  }
  // The same key again (a retry) is the first reply, now that its lead is known.
  const existing = await prior(req, body.clientKey, leadId);
  if (existing) return existing;
  await sendable(req, leadId);
  const verdict = limiter.take(req.actor!.userId);
  if (!verdict.ok)
    throw new HttpError(429, "TOO_MANY", "That's a lot of messages at once. Wait a minute and send again.", {
      retryAfterSec: verdict.retryAfterSec,
    });
  const id = newId();
  const raced = await insertOnce(req, body.clientKey, leadId, () =>
    req.db.execute(sql`
      INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, comment_id, text, status)
      VALUES (${id}, ${t!.id}, ${leadId}, ${c.account_id}, ${req.actor!.userId}, ${body.clientKey}, 'private_reply',
              ${c.comment_id}, ${body.text}, 'queued')`),
  );
  if (raced) return raced;
  await req.db.execute(sql`
    UPDATE instagram_comments SET private_reply = 'queued', thread_id = coalesce(thread_id, ${t!.id}) WHERE id = ${c.id}`);
  req.afterCommit(() => void d.instagram?.enqueueSend(id));
  return { message: await viewOf(req, id) };
}

/** Take a conversation over (flows and LUME AI stop for it), or hand it back. Seen with its lead, as the sender. */
export async function setTakeover(req: FastifyRequest, threadId: string, take: boolean) {
  const t = (
    await req.db.execute<{ id: string; lead_id: string | null; taken_over_by: string | null }>(sql`
      SELECT id, lead_id, taken_over_by FROM instagram_threads WHERE id = ${threadId} AND lead_id IS NOT NULL FOR UPDATE`)
  ).rows[0];
  if (!t) throw notFound("THREAD_NOT_FOUND", "That Instagram conversation isn't on a lead you can see.");
  const lead = await visibleLead(req, t.lead_id!);
  if (!canOnRecord(req.actor!, "messages.send", lead.ownerId)) throw forbidden();
  if (take) await takeOver(req, t.id);
  else
    await req.db.execute(sql`
      UPDATE instagram_threads SET taken_over_by = NULL, taken_over_at = NULL, updated_at = now() WHERE id = ${t.id}`);
  const r = (
    await req.db.execute<{ taken_over_by: string | null; name: string | null }>(sql`
      SELECT t.taken_over_by, u.name FROM instagram_threads t LEFT JOIN users u ON u.id = t.taken_over_by WHERE t.id = ${t.id}`)
  ).rows[0]!;
  return { takenOver: r.taken_over_by ? { id: r.taken_over_by, name: r.name ?? "" } : null };
}
