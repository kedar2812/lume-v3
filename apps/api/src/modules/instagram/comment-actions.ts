import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { canOnRecord } from "@lume/core";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../../http/errors";
import { visibleLead } from "../leads/service";
import { igGraph, type GraphAnswer, type IgGraph } from "./graph";
import { requireInstagram } from "./send";
import { igGraphOf, igTokenContext } from "./service";
import { tokenRefused } from "./token-refresh";

/**
 * A person answering, hiding or deleting a comment from a lead's Instagram tab (plan 2026-11-27-instagram-comment-actions):
 * one call to Instagram each, under the comment's row lock, so a double press or a second tab finds it done and never
 * asks Instagram twice. LUME keeps what Instagram now shows only once Instagram has taken it; a public reply whose
 * answer never came is kept as maybe there, never sent again by itself (as a DM LUME can't be sure of).
 */

/** Instagram's limit for a comment's words. */
export const COMMENT_MAX = 2200;

type Row = {
  id: string;
  comment_id: string;
  account_id: string;
  thread_id: string | null;
  live: boolean;
  hidden: boolean;
  deleted_at: Date | string | null;
  public_reply_at: Date | string | null;
  public_reply: string | null;
  public_reply_unsure: boolean;
  status: string;
  token_enc: Buffer | null;
};

/** A refusal that keeps what it did (a reply that may be there): answered, so it commits. */
export type Refused = { refused: HttpError };

const DELETED = "This comment was deleted from Instagram.";
const UNSURE =
  "Instagram didn't answer, so LUME can't tell whether the reply went. Check Instagram before replying again.";

/** The comment, locked, if this person may act on it: one on a lead they see. */
async function lockedComment(req: FastifyRequest, id: string): Promise<Row> {
  await requireInstagram(req);
  const c = (
    await req.db.execute<Row>(sql`
      SELECT c.id, c.comment_id, c.account_id, c.thread_id, c.live, c.hidden, c.deleted_at, c.public_reply_at,
             c.public_reply, c.public_reply_unsure, a.status, a.token_enc
        FROM instagram_comments c JOIN instagram_accounts a ON a.id = c.account_id
       WHERE c.id = ${id} FOR UPDATE OF c`)
  ).rows[0];
  if (!c) throw notFound("COMMENT_NOT_FOUND", "That comment isn't here.");
  // On a lead this person sees (row-level security on the thread decides; the lead's own check says it in words).
  const lead = c.thread_id
    ? (
        await req.db.execute<{ lead_id: string | null }>(
          sql`SELECT lead_id FROM instagram_threads WHERE id = ${c.thread_id}`,
        )
      ).rows[0]?.lead_id
    : null;
  if (!lead) throw notFound("COMMENT_NOT_FOUND", "That comment isn't here.");
  // Answering, hiding or deleting it speaks for the business on the lead's conversation: as sending to them (I6).
  const seen = await visibleLead(req, lead);
  if (!canOnRecord(req.actor!, "messages.send", seen.ownerId)) throw forbidden();
  return c;
}

function ready(c: Row) {
  if (c.status !== "active" || !c.token_enc)
    throw conflict(
      "ACCOUNT_NOT_READY",
      "This Instagram account needs connecting again before LUME can act on it.",
    );
}

const codeOf = (r: GraphAnswer) => (r.data.error as { code?: number } | undefined)?.code ?? null;
/** No answer from Instagram (down, or the answer lost): it may or may not have happened. */
const unclear = (r: GraphAnswer) => codeOf(r) === null && (r.status === 0 || r.status >= 500);
/** Instagram's rate limits (as LUME's sender reads them). */
const RATE = new Set([4, 17, 32, 613]);

/**
 * Meta's refusal in LUME's words. A refused token tells the admins (the account needs connecting again, everywhere in
 * LUME); code 100 is Meta's generic "can't do that", so the comment is read on its own to know whether it's gone.
 */
async function refusal(
  req: FastifyRequest,
  d: AppDeps,
  g: IgGraph,
  c: Row,
  r: GraphAnswer,
): Promise<HttpError | "gone"> {
  const code = codeOf(r);
  if (code === 190) {
    await tokenRefused(d.pool, c.account_id);
    return conflict("ACCOUNT_NOT_READY", "Instagram stopped letting LUME in. Connect this account again.");
  }
  if (code !== null && RATE.has(code))
    return new HttpError(429, "INSTAGRAM_BUSY", "Instagram asked LUME to slow down. Try again in a minute.");
  if (code === 10 || code === 200)
    return new HttpError(
      403,
      "INSTAGRAM_NOT_ALLOWED",
      "Instagram doesn't allow LUME to do that on this account yet.",
    );
  if (code === 100) {
    const read = await g.comment(c.comment_id);
    if (!read.ok && codeOf(read) === 100) return "gone";
  }
  if (unclear(r)) return new HttpError(502, "INSTAGRAM_DOWN", "Instagram didn't answer. Try again.");
  return conflict("INSTAGRAM_REFUSED", "Instagram didn't allow that.");
}

const graphOf = (d: AppDeps, c: Row) =>
  igGraph(igGraphOf(d), d.keyring.decrypt(c.token_enc!, igTokenContext(c.account_id)));

const markGone = (req: FastifyRequest, c: Row) =>
  req.db.execute(
    sql`UPDATE instagram_comments SET deleted_at = now() WHERE id = ${c.id} AND deleted_at IS NULL`,
  );

const view = (c: {
  hidden: boolean;
  deleted_at: unknown;
  public_reply: string | null;
  public_reply_unsure?: boolean;
}) => ({
  hidden: c.hidden,
  deleted: c.deleted_at !== null,
  publicReply: c.public_reply,
  publicReplyUnsure: c.public_reply_unsure ?? false,
});

/** A public reply under the comment (Instagram: "create a comment"), once from LUME, a flow's included. */
export async function replyPublicly(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  text: string,
): Promise<ReturnType<typeof view> | Refused> {
  const words = text.trim();
  if (!words) throw badRequest("TEXT_REQUIRED", "Write the reply first.");
  if ([...words].length > COMMENT_MAX)
    throw badRequest("TOO_LONG", "Instagram allows up to 2,200 characters in a comment.");
  const c = await lockedComment(req, id);
  if (c.deleted_at) throw conflict("COMMENT_DELETED", DELETED);
  if (c.public_reply_at)
    throw conflict("PUBLIC_REPLY_DONE", "This comment already has a public reply from LUME.");
  if (c.live)
    throw conflict("LIVE_COMMENT", "Instagram lets a business answer a live comment only during the live.");
  ready(c);
  const g = graphOf(d, c);
  const r = await g.publicReply(c.comment_id, words);
  if (!r.ok && unclear(r)) {
    // It may be under their comment already: kept as maybe there, and never sent again by itself.
    await req.db.execute(sql`
      UPDATE instagram_comments SET public_reply = ${words}, public_reply_unsure = true, public_reply_at = now()
       WHERE id = ${c.id}`);
    await audit(req, {
      action: "instagram.comment_replied",
      entityType: "instagram_comment",
      entityId: c.id,
      diff: { public: true, unsure: true },
    });
    return { refused: new HttpError(502, "INSTAGRAM_UNSURE", UNSURE) };
  }
  if (!r.ok) {
    const why = await refusal(req, d, g, c, r);
    if (why === "gone") {
      await markGone(req, c);
      return { refused: conflict("COMMENT_DELETED", DELETED) };
    }
    throw why;
  }
  const replyId = typeof r.data.id === "string" ? r.data.id : null;
  await req.db.execute(sql`
    UPDATE instagram_comments SET public_reply = ${words}, public_reply_id = ${replyId}, public_reply_at = now()
     WHERE id = ${c.id}`);
  await audit(req, {
    action: "instagram.comment_replied",
    entityType: "instagram_comment",
    entityId: c.id,
    diff: { public: true },
  });
  return view({ ...c, public_reply: words });
}

/** Hide or show it again on Instagram: the only update Instagram allows to a comment. Already so: nothing asked. */
export async function hideComment(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  hidden: boolean,
): Promise<ReturnType<typeof view> | Refused> {
  const c = await lockedComment(req, id);
  if (c.deleted_at) throw conflict("COMMENT_DELETED", DELETED);
  if (c.hidden === hidden) return view(c);
  ready(c);
  const g = graphOf(d, c);
  const r = await g.hideComment(c.comment_id, hidden);
  if (!r.ok) {
    const why = await refusal(req, d, g, c, r);
    if (why === "gone") {
      await markGone(req, c);
      return { refused: conflict("COMMENT_DELETED", DELETED) };
    }
    throw why;
  }
  await req.db.execute(sql`UPDATE instagram_comments SET hidden = ${hidden} WHERE id = ${c.id}`);
  await audit(req, {
    action: hidden ? "instagram.comment_hidden" : "instagram.comment_shown",
    entityType: "instagram_comment",
    entityId: c.id,
    diff: { hidden },
  });
  return view({ ...c, hidden });
}

/** Delete it from Instagram. Already deleted (here, or found gone there): done, with nothing more asked. */
export async function deleteComment(req: FastifyRequest, d: AppDeps, id: string) {
  const c = await lockedComment(req, id);
  if (c.deleted_at) return view(c);
  ready(c);
  const g = graphOf(d, c);
  const r = await g.deleteComment(c.comment_id);
  if (!r.ok) {
    const why = await refusal(req, d, g, c, r);
    if (why !== "gone") throw why;
  }
  await markGone(req, c);
  await audit(req, {
    action: "instagram.comment_deleted",
    entityType: "instagram_comment",
    entityId: c.id,
    diff: {},
  });
  return view({ ...c, deleted_at: new Date() });
}
