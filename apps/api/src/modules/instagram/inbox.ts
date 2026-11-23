import { canOnRecord, isStop, maskInstagram } from "@lume/core";
import { schema } from "@lume/db";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { HttpError, notFound } from "../../http/errors";
import { setDoNotContact } from "../leads/dnc";
import { createInstagramLead, leadByHandle, noteHandleMatch } from "./leads";
import { moveInboxToLead } from "./profile";
import { withAllScope } from "./service";

const INBOX_DAYS = 14;
const EVENTS_DAYS = 30;
/** Comments that never became a conversation: kept this long (flows, Meta's re-sends), then gone. */
const COMMENT_DAYS = 30;
const PAGE = 100;

/**
 * Instagram's "Not a lead yet" (NEW_FEATURES_PLAN §4.3): one row per person waiting, newest first, 100 a page
 * (`before`: the oldest `lastAt` seen). Row-level security decides who sees: the account's owner and whoever sees
 * every lead.
 */
export async function igInboxView(req: FastifyRequest, before: string | null) {
  const r = await req.db.execute<{
    thread_id: string;
    username: string | null;
    name: string | null;
    account_id: string;
    account: string;
    owner: string | null;
    count: number;
    last_text: string | null;
    last_at: Date;
  }>(sql`
    SELECT t.id AS thread_id, t.username, t.name, t.account_id, a.username AS account, a.owner_user_id AS owner,
           count(*)::int AS count,
           (array_agg(CASE WHEN i.unsent THEN NULL ELSE i.text END ORDER BY i.at DESC))[1] AS last_text,
           max(i.at) AS last_at
      FROM instagram_inbox i
      JOIN instagram_threads t ON t.id = i.thread_id AND t.lead_id IS NULL
      JOIN instagram_accounts a ON a.id = t.account_id AND a.status <> 'disconnected'
     GROUP BY t.id, a.username, a.owner_user_id
    HAVING ${before}::timestamptz IS NULL OR max(i.at) < ${before}::timestamptz
     ORDER BY max(i.at) DESC, t.id
     LIMIT ${PAGE}`);
  // A handle is a contact, and these people are nobody's lead yet: whole for someone who sees every lead's contacts
  // in full, and for the account's own owner (it's their Instagram, where the handle shows anyway); masked for anyone
  // else who may see the row (a manager who sees every lead, but contacts only masked).
  const fullAll = canOnRecord(req.actor!, "leads.contact.full", null);
  return {
    people: r.rows.map((x) => ({
      threadId: x.thread_id,
      username: x.username
        ? fullAll || x.owner === req.actor!.userId
          ? x.username
          : maskInstagram(x.username).slice(1)
        : null,
      name: x.name,
      account: { id: x.account_id, username: x.account },
      count: x.count,
      lastText: x.last_text,
      lastAt: new Date(x.last_at).toISOString(),
    })),
  };
}

async function waiting(req: FastifyRequest, threadId: string) {
  const r = await req.db.execute<{
    id: string;
    account_id: string;
    igsid: string;
    username: string | null;
    name: string | null;
    lead_id: string | null;
  }>(sql`
    SELECT id, account_id, igsid, username, name, lead_id FROM instagram_threads WHERE id = ${threadId} FOR UPDATE`);
  const t = r.rows[0];
  const has = t
    ? await req.db.execute(sql`SELECT 1 FROM instagram_inbox WHERE thread_id = ${threadId} LIMIT 1`)
    : null;
  if (!t || t.lead_id || !has?.rows.length)
    throw notFound("NOT_IN_INBOX", "Nothing from this person is waiting here.");
  return t;
}

/** One person's messages, oldest first: words, what came with them, and whether they took one back. */
export async function igInboxPerson(req: FastifyRequest, threadId: string) {
  await waiting(req, threadId);
  const rows = await req.db
    .select()
    .from(schema.instagramInbox)
    .where(eq(schema.instagramInbox.threadId, threadId))
    .orderBy(schema.instagramInbox.at);
  return {
    messages: rows.map((m) => ({
      id: m.id,
      at: m.at.toISOString(),
      text: m.unsent ? null : m.text,
      unsent: m.unsent,
      detail: m.unsent ? {} : m.detail,
    })),
  };
}

/**
 * Make them a lead: under the account's lead source and its owner rule, named as they are on Instagram, with their
 * messages on the lead in their own order. One who said stop while waiting is do not contact from the start.
 */
export async function igMakeLead(req: FastifyRequest, threadId: string) {
  const t = await waiting(req, threadId);
  const [a] = await req.db
    .select()
    .from(schema.instagramAccounts)
    .where(eq(schema.instagramAccounts.id, t.account_id));
  if (!a || a.status === "disconnected")
    throw notFound("NOT_IN_INBOX", "Nothing from this person is waiting here.");
  // The person may add leads (the route checked); the lead may still be someone else's by the source's rule, and the
  // one already holding this handle may be anyone's: every lead in scope, for this alone.
  return withAllScope(req, async () => {
    const matched = await leadByHandle(req, t.username, a.ownerUserId);
    if (matched) await noteHandleMatch(req, matched, threadId);
    const leadId =
      matched ??
      (await createInstagramLead(
        req,
        {
          id: a.id,
          igUserId: a.igUserId,
          username: a.username,
          ownerUserId: a.ownerUserId,
          sourceId: a.sourceId,
          newDmCreatesLead: a.newDmCreatesLead,
        },
        { username: t.username, name: t.name, adId: null, how: "not_a_lead_yet" },
      ));
    if (!leadId) throw new HttpError(409, "NO_PIPELINE", "LUME needs a pipeline with an open stage first.");
    const texts = (
      await req.db.execute<{ text: string | null; at: Date | string }>(
        sql`SELECT text, at FROM instagram_inbox WHERE thread_id = ${threadId} AND NOT unsent ORDER BY at`,
      )
    ).rows;
    await req.db.execute(sql`UPDATE instagram_threads SET lead_id = ${leadId} WHERE id = ${threadId}`);
    await moveInboxToLead(req, threadId, leadId, a.ownerUserId);
    if (texts.some((m) => isStop(m.text ?? "")))
      await setDoNotContact(req, leadId, { reason: "Said stop on Instagram", fromLead: true });
    const last = texts.at(-1)?.at;
    if (last)
      await req.db.execute(sql`
        UPDATE leads SET last_reply_at = GREATEST(coalesce(last_reply_at, ${new Date(last)}), ${new Date(last)})
         WHERE id = ${leadId}`);
    return { leadId };
  });
}

/** Not a lead: their messages and files go, and they never show up here again on that account. */
export async function igIgnore(req: FastifyRequest, threadId: string) {
  const t = await waiting(req, threadId);
  await req.db
    .insert(schema.instagramIgnored)
    .values({ accountId: t.account_id, igsid: t.igsid })
    .onConflictDoNothing();
  await req.db.delete(schema.instagramInbox).where(eq(schema.instagramInbox.threadId, threadId));
  await req.db
    .delete(schema.instagramMedia)
    .where(and(eq(schema.instagramMedia.threadId, threadId), sql`${schema.instagramMedia.leadId} IS NULL`));
  return { ignored: true as const };
}

/**
 * Hourly: Not a lead yet keeps 14 days (with its files), processed deliveries (their bodies long gone) 30, comments
 * that never became a conversation 30, the intake limits' counts 2.
 */
export async function sweepInstagram(pool: pg.Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    await c.query("DELETE FROM instagram_inbox WHERE created_at < now() - make_interval(days => $1)", [
      INBOX_DAYS,
    ]);
    await c.query(
      `DELETE FROM instagram_media WHERE lead_id IS NULL AND created_at < now() - make_interval(days => $1)`,
      [INBOX_DAYS],
    );
    await c.query(
      "DELETE FROM instagram_events WHERE status <> 'queued' AND received_at < now() - make_interval(days => $1)",
      [EVENTS_DAYS],
    );
    // Comments that never became a conversation (nothing queued for them), past what a flow or Meta's retries need.
    await c.query(
      `DELETE FROM instagram_comments
        WHERE thread_id IS NULL AND private_reply <> 'queued' AND created_at < now() - make_interval(days => $1)`,
      [COMMENT_DAYS],
    );
    // The intake limits' counts, once their window is two days past.
    await c.query("DELETE FROM instagram_budgets WHERE window_start < now() - interval '2 days'");
    // Deliveries still waiting for an account that's gone (disconnected, or never here): their content isn't kept.
    await c.query(
      `DELETE FROM instagram_events e
        WHERE e.status = 'queued' AND e.received_at < now() - interval '7 days'
          AND NOT EXISTS (SELECT 1 FROM instagram_accounts a
                           WHERE a.ig_user_id = e.account_ig_id AND a.status <> 'disconnected')`,
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
