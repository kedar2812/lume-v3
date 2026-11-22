import {
  can,
  isStop,
  newId,
  type IgAttachment,
  type IgCommentEvent,
  type IgEvent,
  type IgMessageEvent,
} from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { loadActor } from "../../rbac/actor";
import { jobServer, withJobRequest } from "../imports/job-request";
import { setDoNotContact } from "../leads/dnc";
import { replyArrived } from "../leads/sending";
import { visibleLead } from "../leads/service";
import { readAs } from "../notifications/hub";
import { notify } from "../notifications/notify";
import { igGraph } from "./graph";
import { createInstagramLead, leadByHandle, liveLead, type IgAccountRow } from "./leads";
import { igEventContext } from "./receive";
import { igGraphOf, igTokenContext } from "./service";

export type InstagramJobDeps = { app: FastifyInstance; d: AppDeps };

const PREVIEW = 120;
const AD_WINDOW_MS = 7 * 86_400_000;
const CANT_RUN = "Whoever connected this account can't see leads any more. Connect it again.";
/** An echo seen while LUME's own send to that person is still in flight waits this long, then is looked at again. */
export const ECHO_WAIT_MS = 30_000;
const MEDIA_KINDS: Partial<Record<IgAttachment["type"], "image" | "video" | "audio" | "file">> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "file",
};
const WORDS: Partial<Record<IgAttachment["type"], string>> = {
  image: "Sent a photo",
  video: "Sent a video",
  audio: "Sent a voice note",
  file: "Sent a file",
  share: "Shared a post",
  story_mention: "Mentioned you in their story",
  ig_reel: "Shared a reel",
  reel: "Shared a reel",
};
const firstName = (n: string | null) => n?.trim().split(/\s+/)[0] || null;

/** What a message said, for a notice: its words, or what it was. */
export function igGist(e: Pick<IgMessageEvent, "text" | "attachments" | "replyToStory">): string {
  if (e.text?.trim()) return e.text.slice(0, PREVIEW);
  const a = e.attachments[0];
  if (a) return WORDS[a.type] ?? "Sent a message";
  return e.replyToStory ? "Replied to your story" : "Sent a message";
}

/** What's kept of a message beside its words (no Meta links: they expire, and the files are kept here instead). */
function detailOf(e: IgMessageEvent) {
  return {
    attachments: e.attachments.map((a) => a.type),
    ...(e.replyToStory ? { story: { id: e.replyToStory.id } } : {}),
    ...(e.storyMention ? { mention: true } : {}),
    ...(e.quickReply ? { tap: { payload: e.quickReply } } : {}),
    ...(e.referral
      ? { referral: { source: e.referral.source, adId: e.referral.adId, ref: e.referral.ref } }
      : {}),
  };
}

type Thread = {
  id: string;
  lead_id: string | null;
  username: string | null;
  name: string | null;
  last_in_at: Date | null;
  profile_read_at: Date | null;
  taken_over_by: string | null;
  created: boolean;
};

/**
 * The conversation, made or found, and locked for this transaction: two deliveries for one person queue up here. The
 * lock comes first, in its own statement, so the conversation is read afresh once it's ours: a lead the other delivery
 * just made is seen (and row-level security's check on it passes), never made twice.
 */
async function threadFor(req: FastifyRequest, accountId: string, igsid: string): Promise<Thread> {
  await req.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`instagram:${accountId}:${igsid}`}, 0))`,
  );
  const r = await req.db.execute<Thread>(sql`
    INSERT INTO instagram_threads (id, account_id, igsid) VALUES (${newId()}, ${accountId}, ${igsid})
    ON CONFLICT (account_id, igsid) DO UPDATE SET updated_at = now()
    RETURNING id, lead_id, username, name, last_in_at, profile_read_at, taken_over_by, (xmax = 0) AS created`);
  return r.rows[0]!;
}

/** The person acted (wrote, tapped, reacted): Meta's window opens from this moment, never moved back. */
async function personActed(req: FastifyRequest, threadId: string, at: Date, adWindow: boolean) {
  await req.db.execute(sql`
    UPDATE instagram_threads
       SET last_in_at = GREATEST(coalesce(last_in_at, ${at}), ${at}),
           last_message_at = GREATEST(coalesce(last_message_at, ${at}), ${at}),
           ad_window_until = CASE WHEN ${adWindow}
             THEN GREATEST(coalesce(ad_window_until, ${new Date(at.getTime() + AD_WINDOW_MS)}),
                           ${new Date(at.getTime() + AD_WINDOW_MS)})
             ELSE ad_window_until END,
           updated_at = now()
     WHERE id = ${threadId}`);
}

type Notice = {
  ownerId: string;
  leadId: string;
  kind: "lead_replied" | "lead_stopped";
  title: string;
  body: string;
};
type Out = { media: string[]; notice: Notice | null; profile: string | null; later: boolean };

/**
 * The person's name and username, read once they've messaged (Meta allows it then). Answers whether it was read; a
 * refusal of consent counts as read (never asked again), Meta being down doesn't (the profile job tries later).
 */
async function readProfile(
  req: FastifyRequest,
  d: AppDeps,
  token: string,
  t: Thread,
  igsid: string,
): Promise<boolean> {
  const r = await igGraph(igGraphOf(d), token).profile(igsid);
  const username = typeof r.data.username === "string" ? r.data.username : null;
  const name = typeof r.data.name === "string" && r.data.name.trim() ? r.data.name.trim() : null;
  if (r.ok) {
    await req.db.execute(sql`
      UPDATE instagram_threads SET username = coalesce(${username}, username), name = coalesce(${name}, name),
             profile_read_at = now() WHERE id = ${t.id}`);
    t.username = username ?? t.username;
    t.name = name ?? t.name;
    return true;
  }
  if (r.status >= 400 && r.status < 500 && (r.data.error as { code?: unknown } | undefined)?.code !== 190) {
    await req.db.execute(sql`UPDATE instagram_threads SET profile_read_at = now() WHERE id = ${t.id}`);
    return true;
  }
  return false;
}

/** Whether this message is on the lead already: it came before, or it's a message LUME itself sent. */
async function onLeadAlready(req: FastifyRequest, leadId: string, mid: string) {
  const dup = await req.db.execute(sql`
    SELECT 1 FROM activities
     WHERE lead_id = ${leadId} AND type IN ('instagram_received', 'instagram_sent') AND payload->>'mid' = ${mid}
    UNION ALL
    SELECT 1 FROM instagram_outbox WHERE lead_id = ${leadId} AND mid = ${mid}
     LIMIT 1`);
  return dup.rows.length > 0;
}

async function addMedia(
  req: FastifyRequest,
  accountId: string,
  t: { id: string; leadId: string | null },
  mid: string,
  attachments: IgAttachment[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, a] of attachments.entries()) {
    const kind = MEDIA_KINDS[a.type];
    if (!kind || !a.url) continue;
    const id = newId();
    const r = await req.db.execute(sql`
      INSERT INTO instagram_media (id, account_id, thread_id, lead_id, mid, position, url, kind, status)
      VALUES (${id}, ${accountId}, ${t.id}, ${t.leadId}, ${mid}, ${i}, ${a.url}, ${kind}, 'waiting')
      ON CONFLICT (mid, position) DO NOTHING`);
    if (r.rowCount) ids.push(id);
  }
  return ids;
}

async function messageIn(
  req: FastifyRequest,
  d: AppDeps,
  account: IgAccountRow & { token: string },
  e: IgMessageEvent,
  out: Out,
) {
  const at = new Date(e.at);
  const t = await threadFor(req, account.id, e.igsid);
  const ad = e.referral?.source?.toUpperCase() === "ADS";
  await personActed(req, t.id, at, ad);
  if (e.referral && (t.created || ad))
    await req.db.execute(sql`
      UPDATE instagram_threads SET source = source || ${JSON.stringify({
        trigger: ad ? "ad" : "referral",
        ...(e.referral.adId ? { adId: e.referral.adId } : {}),
        ...(e.referral.ref ? { ref: e.referral.ref } : {}),
      })}::jsonb WHERE id = ${t.id} AND (source = '{}'::jsonb OR ${ad})`);

  let leadId = await liveLead(req, t.lead_id);
  if (!leadId) {
    // Who this is: read their name and username first (allowed now they've written), so a lead that came in from
    // ManyChat or a sheet under the same handle is found rather than made twice.
    if (!t.profile_read_at && !(await readProfile(req, d, account.token, t, e.igsid))) out.profile = t.id;
    const ignored = await req.db.execute(
      sql`SELECT 1 FROM instagram_ignored WHERE account_id = ${account.id} AND igsid = ${e.igsid}`,
    );
    leadId = await leadByHandle(req, t.username, account.ownerUserId);
    if (!leadId && account.newDmCreatesLead && !ignored.rows.length)
      leadId = await createInstagramLead(req, account, {
        username: t.username,
        name: t.name,
        adId: e.referral?.adId ?? null,
        how: ad ? "ad" : e.replyToStory ? "story_reply" : e.storyMention ? "story_mention" : "dm",
      });
    if (leadId)
      await req.db.execute(sql`UPDATE instagram_threads SET lead_id = ${leadId} WHERE id = ${t.id}`);
    else {
      if (!ignored.rows.length) {
        await req.db.execute(sql`
          INSERT INTO instagram_inbox (id, thread_id, mid, at, text, detail)
          VALUES (${newId()}, ${t.id}, ${e.mid}, ${at}, ${e.text}, ${JSON.stringify(detailOf(e))}::jsonb)
          ON CONFLICT (mid) DO NOTHING`);
        out.media.push(
          ...(await addMedia(req, account.id, { id: t.id, leadId: null }, e.mid, e.attachments)),
        );
      }
      return;
    }
  }
  if (await onLeadAlready(req, leadId, e.mid)) return;
  await req.db.execute(sql`
    INSERT INTO activities (id, lead_id, user_id, type, occurred_at, payload)
    VALUES (${newId()}, ${leadId}, ${account.ownerUserId}, 'instagram_received', ${at},
            ${JSON.stringify({ mid: e.mid, accountId: account.id, threadId: t.id, text: e.text, ...detailOf(e) })}::jsonb)`);
  out.media.push(...(await addMedia(req, account.id, { id: t.id, leadId }, e.mid, e.attachments)));
  await req.db.execute(sql`
    UPDATE leads SET last_reply_at = GREATEST(coalesce(last_reply_at, ${at}), ${at}),
                     last_activity_at = GREATEST(coalesce(last_activity_at, ${at}), ${at}),
                     ad_id = coalesce(ad_id, ${e.referral?.adId ?? null})
     WHERE id = ${leadId}`);
  const lead = await visibleLead(req, leadId);
  // Stop means stop, in any words, before anything else: at once, by nobody, undoable by a person.
  let stopped = false;
  if (!lead.dncAt && isStop(e.text ?? "")) {
    await setDoNotContact(req, leadId, { reason: "Said stop on Instagram", fromLead: true });
    stopped = true;
  }
  // As tapping "They replied" does: the stage's reply move, and repeats waiting on a reply stop.
  await replyArrived(req, lead);
  if (lead.ownerId)
    out.notice = {
      ownerId: lead.ownerId,
      leadId,
      kind: stopped ? "lead_stopped" : "lead_replied",
      title: stopped
        ? `${firstName(lead.name) ?? "A lead"} asked not to be messaged`
        : `${firstName(lead.name) ?? "A lead"} replied on Instagram`,
      body: igGist(e),
    };
}

/** A message the business sent from Instagram itself: on the lead, and a person has taken the conversation over. */
async function echo(
  req: FastifyRequest,
  account: IgAccountRow & { runAs: string },
  e: IgMessageEvent,
  out: Out,
) {
  const at = new Date(e.at);
  const found = await req.db.execute<{ id: string; lead_id: string | null }>(sql`
    SELECT id, lead_id FROM instagram_threads WHERE account_id = ${account.id} AND igsid = ${e.igsid} FOR UPDATE`);
  const t = found.rows[0];
  const leadId = await liveLead(req, t?.lead_id ?? null);
  // Nothing is kept of a stranger's conversation from the business's side (as WhatsApp's).
  if (!t || !leadId) return;
  if (await onLeadAlready(req, leadId, e.mid)) return;
  // LUME's own send to this person still in flight: this echo may be it, so it's looked at again shortly.
  const flight = await req.db.execute(sql`
    SELECT 1 FROM instagram_outbox WHERE thread_id = ${t.id} AND status = 'sending' LIMIT 1`);
  if (flight.rows.length) {
    out.later = true;
    return;
  }
  await req.db.execute(sql`
    INSERT INTO activities (id, lead_id, user_id, type, occurred_at, payload)
    VALUES (${newId()}, ${leadId}, ${account.ownerUserId}, 'instagram_sent', ${at},
            ${JSON.stringify({ mid: e.mid, accountId: account.id, threadId: t.id, text: e.text, via: "echo", ...detailOf(e) })}::jsonb)`);
  await req.db.execute(sql`
    UPDATE instagram_threads
       SET last_out_at = GREATEST(coalesce(last_out_at, ${at}), ${at}),
           last_message_at = GREATEST(coalesce(last_message_at, ${at}), ${at}),
           -- Who answered from the app isn't known: the account's owner, else the lead's, else whoever connected it.
           taken_over_by = coalesce(taken_over_by, ${account.ownerUserId}::uuid,
                                    (SELECT owner_id FROM leads WHERE id = ${leadId}), ${account.runAs}::uuid),
           taken_over_at = coalesce(taken_over_at, now())
     WHERE id = ${t.id}`);
  await req.db.execute(sql`
    UPDATE leads SET last_message_at = GREATEST(coalesce(last_message_at, ${at}), ${at}),
                     last_activity_at = GREATEST(coalesce(last_activity_at, ${at}), ${at})
     WHERE id = ${leadId}`);
}

async function comment(req: FastifyRequest, account: IgAccountRow, e: IgCommentEvent) {
  // The account's own comments (its replies under its posts) never start anything.
  if (e.fromIgsid === account.igUserId) return;
  const t = await req.db.execute<{ id: string }>(sql`
    SELECT id FROM instagram_threads WHERE account_id = ${account.id} AND igsid = ${e.fromIgsid}`);
  await req.db.execute(sql`
    INSERT INTO instagram_comments
      (id, account_id, comment_id, media_id, media_type, parent_id, from_igsid, from_username, text, ad_id, live, at, thread_id)
    VALUES (${newId()}, ${account.id}, ${e.commentId}, ${e.mediaId}, ${e.mediaType}, ${e.parentId}, ${e.fromIgsid},
            ${e.fromUsername}, ${e.text}, ${e.adId}, ${e.live}, ${new Date(e.at)}, ${t.rows[0]?.id ?? null})
    ON CONFLICT (comment_id) DO NOTHING`);
}

type Row = {
  status: string;
  event_enc: Buffer | null;
  event_key: string;
  account_ig_id: string;
  account_id: string | null;
  account_status: string | null;
  owner_user_id: string | null;
  run_as: string | null;
  source_id: string | null;
  new_dm_creates_lead: boolean | null;
  username: string | null;
  token_enc: Buffer | null;
};

/**
 * One Instagram delivery into LUME (NEW_FEATURES_PLAN §4.3): a person's message on their lead (made or found) or in
 * Not a lead yet; the business's own message (an echo) on the lead, taking the conversation over; a tap, reaction or
 * ad click opening Meta's window; a read marking LUME's messages read; an unsend taking the words away; a comment kept
 * for flows. Runs as whoever connected the account, seeing every lead. "later": looked at again in 30 seconds.
 */
export async function processInstagramEvent(
  o: InstagramJobDeps,
  eventId: number,
): Promise<"done" | "waiting" | "gone" | "later"> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  const { rows } = await pool.query<Row>(
    `SELECT e.status, e.event_enc, e.event_key, e.account_ig_id, a.id AS account_id, a.status AS account_status,
            a.owner_user_id, a.run_as, a.source_id, a.new_dm_creates_lead, a.username, a.token_enc
       FROM instagram_events e LEFT JOIN instagram_accounts a ON a.ig_user_id = e.account_ig_id
      WHERE e.id = $1`,
    [eventId],
  );
  const row = rows[0];
  if (!row || row.status !== "queued" || !row.event_enc) return "gone";
  if (!row.account_id || row.account_status === "disconnected" || !row.token_enc) {
    await pool.query(
      "UPDATE instagram_events SET status = 'done', event_enc = NULL, processed_at = now() WHERE id = $1",
      [eventId],
    );
    return "gone";
  }
  const actor = await loadActor(pool, row.run_as!);
  if (!actor || !can(actor, "leads.view")) {
    await pool.query(
      "UPDATE instagram_accounts SET status = 'needs_attention', problem = $2, updated_at = now() WHERE id = $1 AND status = 'active'",
      [row.account_id, CANT_RUN],
    );
    return "waiting";
  }
  const ev = JSON.parse(
    d.keyring.decrypt(row.event_enc, igEventContext(row.account_ig_id, row.event_key)),
  ) as IgEvent;
  const account = {
    id: row.account_id,
    igUserId: row.account_ig_id,
    username: row.username ?? "",
    ownerUserId: row.owner_user_id,
    sourceId: row.source_id,
    newDmCreatesLead: row.new_dm_creates_lead ?? true,
    runAs: row.run_as!,
    token: d.keyring.decrypt(row.token_enc, igTokenContext(row.account_id)),
  };

  const out = await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `instagram-event:${eventId}`, allLeads: true },
    async (req): Promise<Out | null> => {
      const lock = await req.db.execute<{ status: string }>(
        sql`SELECT status FROM instagram_events WHERE id = ${eventId} FOR UPDATE`,
      );
      if (lock.rows[0]?.status !== "queued") return null;
      const out: Out = { media: [], notice: null, profile: null, later: false };
      const at = new Date(ev.at);
      switch (ev.kind) {
        case "message":
          if (ev.isEcho) await echo(req, account, ev, out);
          else await messageIn(req, d, account, ev, out);
          break;
        case "postback": {
          const t = await threadFor(req, account.id, ev.igsid);
          await personActed(req, t.id, at, false);
          const leadId = await liveLead(req, t.lead_id);
          const payload = { tap: { title: ev.title, payload: ev.payload } };
          if (leadId && !(await onLeadAlready(req, leadId, ev.mid)))
            await req.db.execute(sql`
              INSERT INTO activities (id, lead_id, user_id, type, occurred_at, payload)
              VALUES (${newId()}, ${leadId}, ${account.ownerUserId}, 'instagram_received', ${at},
                      ${JSON.stringify({ mid: ev.mid, accountId: account.id, threadId: t.id, text: ev.title, ...payload })}::jsonb)`);
          else if (!leadId)
            await req.db.execute(sql`
              INSERT INTO instagram_inbox (id, thread_id, mid, at, text, detail)
              VALUES (${newId()}, ${t.id}, ${ev.mid}, ${at}, ${ev.title}, ${JSON.stringify(payload)}::jsonb)
              ON CONFLICT (mid) DO NOTHING`);
          break;
        }
        case "referral": {
          const t = await threadFor(req, account.id, ev.igsid);
          await personActed(req, t.id, at, ev.referral.source?.toUpperCase() === "ADS");
          break;
        }
        case "reaction": {
          const t = await threadFor(req, account.id, ev.igsid);
          if (ev.action === "react") await personActed(req, t.id, at, false);
          await req.db.execute(sql`
            UPDATE instagram_outbox SET reaction = ${ev.action === "react" ? (ev.emoji ?? "❤") : null}, updated_at = now()
             WHERE mid = ${ev.mid} AND thread_id = ${t.id}`);
          break;
        }
        case "seen":
          // Everything LUME sent to this person up to the message they read is read.
          await req.db.execute(sql`
            UPDATE instagram_outbox o SET status = 'read', updated_at = now()
              FROM instagram_threads t
             WHERE t.account_id = ${account.id} AND t.igsid = ${ev.igsid} AND o.thread_id = t.id AND o.status = 'sent'
               AND o.created_at <= (SELECT created_at FROM instagram_outbox WHERE mid = ${ev.mid})`);
          break;
        case "unsend": {
          // The person took it back: its words and files go; the thread says a message was removed.
          const t = await req.db.execute<{ id: string; lead_id: string | null }>(sql`
            SELECT id, lead_id FROM instagram_threads WHERE account_id = ${account.id} AND igsid = ${ev.igsid}`);
          const th = t.rows[0];
          if (!th) break;
          await req.db.execute(
            sql`UPDATE instagram_inbox SET text = NULL, detail = '{}'::jsonb, unsent = true WHERE mid = ${ev.mid}`,
          );
          await req.db.execute(
            sql`DELETE FROM instagram_media WHERE mid = ${ev.mid} AND thread_id = ${th.id}`,
          );
          const leadId = await liveLead(req, th.lead_id);
          if (leadId) {
            const had = await req.db.execute(sql`
              SELECT 1 FROM activities WHERE lead_id = ${leadId} AND type = 'instagram_received' AND payload->>'mid' = ${ev.mid}`);
            if (had.rows.length)
              await req.db.execute(sql`
                INSERT INTO activities (id, lead_id, user_id, type, occurred_at, payload)
                VALUES (${newId()}, ${leadId}, NULL, 'instagram_unsent', ${at}, ${JSON.stringify({ mid: ev.mid, threadId: th.id })}::jsonb)`);
          }
          break;
        }
        case "comment":
          await comment(req, account, ev);
          break;
      }
      if (out.later) return out;
      await req.db.execute(
        sql`UPDATE instagram_events SET status = 'done', event_enc = NULL, processed_at = now() WHERE id = ${eventId}`,
      );
      return out;
    },
  );
  if (!out) return "gone";
  if (out.later) return "later";
  for (const id of out.media)
    await d.instagram
      ?.enqueueMedia(id)
      .catch((err: unknown) => o.app.log.error({ err }, "couldn't queue an Instagram file"));
  if (out.profile)
    await d.instagram
      ?.enqueueProfile(out.profile)
      .catch((err: unknown) => o.app.log.error({ err }, "couldn't queue an Instagram profile read"));
  if (out.notice) {
    const n = out.notice;
    // One notice for a burst: several messages in a row from one lead ring once. A stop is always said.
    const recent = await readAs(pool, n.ownerId, (c) =>
      c.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND lead_id = $2 AND kind = 'lead_replied'
            AND created_at > now() - interval '10 minutes' LIMIT 1`,
        [n.ownerId, n.leadId],
      ),
    );
    if (n.kind === "lead_stopped" || !recent.rows.length)
      await notify(pool, n.ownerId, { kind: n.kind, title: n.title, body: n.body, leadId: n.leadId }).catch(
        (err: unknown) => o.app.log.warn({ err }, "couldn't tell a lead's owner about an Instagram message"),
      );
  }
  return "done";
}
