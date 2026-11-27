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
import { available } from "../ai/service";
import { sendStopApology } from "../autopilot/engine";
import { leadWrote, personSent } from "../autopilot/lead-events";
import { tellPeople } from "../autopilot/ready";
import { giveToAi } from "./ai-intake";
import { jobServer, withJobRequest } from "../imports/job-request";
import { setDoNotContact } from "../leads/dnc";
import { replyArrived } from "../leads/sending";
import { visibleLead } from "../leads/service";
import { readAs } from "../notifications/hub";
import { notify } from "../notifications/notify";
import { firstRefusal, giveBackLead, hourOf, roomForLead } from "./budgets";
import { photoDue } from "./photo";
import { igGraph, type GraphAnswer } from "./graph";
import { afterFlow } from "./flow-due";
import {
  flowOnComment,
  flowOnMessage,
  FLOW_WORDS,
  newFlowOut,
  stopFlowRuns,
  type FlowAccount,
  type FlowOut,
} from "./flow-run";
import { createInstagramLead, leadByHandle, liveLead, noteHandleMatch, type IgAccountRow } from "./leads";
import { igEventContext } from "./receive";
import { igGraphOf, igTokenContext, tellAdmins } from "./service";

export type InstagramJobDeps = { app: FastifyInstance; d: AppDeps };
/** Public replies under comments a flow may queue per account per hour (unset limits: Meta's private-reply pace). */
export const IG_PUBLIC_REPLIES_PER_HOUR = 600;

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
  photo_checked_at: Date | null;
  taken_over_by: string | null;
  source: { trigger?: string; adId?: string } | null;
  created: boolean;
};

/**
 * The conversation, made or found, and locked for this transaction: two deliveries for one person queue up here. The
 * lock comes first, in its own statement, so the conversation is read afresh once it's ours: a lead the other delivery
 * just made is seen (and row-level security's check on it passes), never made twice.
 */
/**
 * What started a conversation, kept as it was when an ad click later changes its trigger (the ad's window applies from
 * then on): Analytics counts each conversation under what started it, and an old range's numbers never move.
 */
const startKept = (created: boolean) =>
  sql`(CASE WHEN ${!created} AND source ->> 'start' IS NULL
            THEN jsonb_build_object('start', coalesce(source ->> 'trigger', 'dm')) ELSE '{}'::jsonb END)`;

async function threadFor(req: FastifyRequest, accountId: string, igsid: string): Promise<Thread> {
  await req.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`instagram:${accountId}:${igsid}`}, 0))`,
  );
  const r = await req.db.execute<Thread>(sql`
    INSERT INTO instagram_threads (id, account_id, igsid) VALUES (${newId()}, ${accountId}, ${igsid})
    ON CONFLICT (account_id, igsid) DO UPDATE SET updated_at = now()
    RETURNING id, lead_id, username, name, last_in_at, profile_read_at, photo_checked_at, taken_over_by, source,
              (xmax = 0) AS created`);
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
type Out = {
  /** LUME AI's run on this conversation: woken once this commits (or, for a stop, its one apology). */
  autopilot: { runId: string; leadId: string; stopped: boolean; running: boolean; ready?: true } | null;
  media: string[];
  notice: Notice | null;
  profile: string | null;
  /** A conversation whose profile photo is due a look (they've written, so Meta will say). */
  photo: string | null;
  later: boolean;
  flow: FlowOut;
  /** A lead's reply, with words, for LUME AI to read the meaning of once this commits (D6a). */
  meaning: string | null;
};
/**
 * The person's message on their lead, written once the flow has had it: a reply said to a flow (the flow answers it)
 * is marked so from the start, as a lead's history is never changed afterwards, and LUME AI doesn't read it and Who
 * replied leaves it be (D6a).
 */
const received = (
  req: FastifyRequest,
  a: { id: string; leadId: string; userId: string | null; at: Date; payload: object; inFlow: string | null },
) =>
  req.db.execute(sql`
    INSERT INTO activities (id, lead_id, user_id, type, occurred_at, payload)
    VALUES (${a.id}, ${a.leadId}, ${a.userId}, 'instagram_received', ${a.at},
            ${JSON.stringify({ ...a.payload, ...(a.inFlow ? { inFlow: a.inFlow } : {}) })}::jsonb)`);

/**
 * The person's name and username, read once they've messaged (Meta allows it then). Answers whether it was read; a
 * refusal of consent counts as read (never asked again), Meta being down doesn't (the profile job tries later).
 */
async function readProfile(req: FastifyRequest, t: Thread, r: GraphAnswer): Promise<boolean> {
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
  account: FlowAccount & { token: string },
  e: IgMessageEvent,
  out: Out,
  pre: GraphAnswer | null,
) {
  const at = new Date(e.at);
  const t = await threadFor(req, account.id, e.igsid);
  const ad = e.referral?.source?.toUpperCase() === "ADS";
  await personActed(req, t.id, at, ad);
  if (photoDue(t.photo_checked_at, d.clock())) out.photo = t.id;
  if (e.referral && (t.created || ad))
    await req.db.execute(sql`
      UPDATE instagram_threads SET source = ${startKept(t.created)} || source || ${JSON.stringify({
        trigger: ad ? "ad" : "referral",
        ...(e.referral.adId ? { adId: e.referral.adId } : {}),
        ...(e.referral.ref ? { ref: e.referral.ref } : {}),
      })}::jsonb WHERE id = ${t.id} AND (source = '{}'::jsonb OR ${ad})`);
  // A conversation a story started says so as it starts (Analytics counts conversations by what started them).
  else if (t.created && (e.replyToStory || e.storyMention))
    await req.db.execute(sql`
      UPDATE instagram_threads SET source = '{"trigger": "story"}'::jsonb WHERE id = ${t.id} AND source = '{}'::jsonb`);

  let leadId = await liveLead(req, t.lead_id);
  if (!leadId) {
    // Who this is: read their name and username first (allowed now they've written), so a lead that came in from
    // ManyChat or a sheet under the same handle is found rather than made twice.
    if (!t.profile_read_at) {
      // Read before this transaction began (so a slow Meta never holds it); read now only if that didn't happen.
      const answer = pre ?? (await igGraph(igGraphOf(d), account.token).profile(e.igsid));
      if (!(await readProfile(req, t, answer))) out.profile = t.id;
    }
    const ignored = await req.db.execute(
      sql`SELECT 1 FROM instagram_ignored WHERE account_id = ${account.id} AND igsid = ${e.igsid}`,
    );
    leadId = await leadByHandle(req, t.username, account.ownerUserId);
    if (leadId) await noteHandleMatch(req, leadId, t.id);
    // A new lead only while the account has room this hour: a flood of strangers waits in Not a lead yet instead.
    const wanted = !leadId && account.newDmCreatesLead && !ignored.rows.length;
    const room = wanted && (await roomForLead(req, account.id, d.clock()));
    if (wanted && !room) out.flow.held = true;
    if (room) {
      leadId = await createInstagramLead(req, account, {
        username: t.username,
        name: t.name,
        adId: e.referral?.adId ?? t.source?.adId ?? null,
        how:
          ad || t.source?.trigger === "ad"
            ? "ad"
            : e.replyToStory
              ? "story_reply"
              : e.storyMention
                ? "story_mention"
                : "dm",
      });
      // Not made after all (no pipeline to put it in): its place this hour goes back.
      if (!leadId) await giveBackLead(req, account.id, d.clock());
    }
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
  // Its id now, so it sorts where it arrived among what the stop or the flow below writes.
  const activityId = newId();
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
  // Who answers (spec 2026-11-22 §2), each row over the ones below: a person who took the conversation over (nothing
  // automated); the LUME AI run working this conversation; the flow it's in, or the one it starts (a lead any run holds
  // starts none); for a DM nothing claims, LUME AI when the account says so; else the team. A stop above has made the
  // lead do-not-contact, which stops any flow; LUME AI's run hears it as its own stop.
  const held = t.taken_over_by
    ? null
    : await leadWrote(req, leadId, at, e.text ?? "", { channel: "instagram", accountId: account.id });
  if (held) out.autopilot = { ...held, leadId };
  const took = held
    ? null
    : await flowOnMessage(
        req,
        account,
        {
          threadId: t.id,
          leadId,
          text: e.text,
          payload: e.quickReply,
          // Only this message's own ad click: a later plain DM from someone who once came from an ad is a DM.
          via: ad ? "ad" : e.replyToStory ? "story_reply" : e.storyMention ? "story_mention" : "dm",
          // Their first message to the account: a conversation a comment flow opened has none before this.
          first: t.created || !t.last_in_at,
          adId: e.referral?.adId ?? t.source?.adId ?? null,
        },
        at,
        out.flow,
      );
  const given =
    !held && !took && !stopped && !t.taken_over_by && account.newDms === "ai"
      ? await giveToAi(req, d, { accountId: account.id, leadId, goal: null })
      : null;
  if (given && given !== "held")
    out.autopilot = { runId: given.runId, leadId, stopped: false, running: true };
  await received(req, {
    id: activityId,
    leadId,
    userId: account.ownerUserId,
    at,
    payload: { mid: e.mid, accountId: account.id, threadId: t.id, text: e.text, ...detailOf(e) },
    inFlow: took,
  });
  // What it means, when there are words and LUME AI is on (a stop is settled already; a flow answers its own).
  // A tap on a quick reply is a button's words, never theirs: not read.
  // A conversation LUME AI answers is its own (as WhatsApp's run leads).
  if (!took && !held && !given && !stopped && !e.quickReply && e.text?.trim() && (await available(req, d)).ok)
    out.meaning = activityId;
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
  await stopFlowRuns(req, { threadId: t.id }, FLOW_WORDS.takenOver);
  await personSent(req, leadId, { channel: "instagram", accountId: account.id });
  await req.db.execute(sql`
    UPDATE leads SET last_message_at = GREATEST(coalesce(last_message_at, ${at}), ${at}),
                     last_activity_at = GREATEST(coalesce(last_activity_at, ${at}), ${at})
     WHERE id = ${leadId}`);
}

async function comment(
  req: FastifyRequest,
  account: FlowAccount,
  e: IgCommentEvent,
  out: Out,
  o: { now: Date; publicRepliesPerHour: number },
) {
  // The account's own comments (its replies under its posts) never start anything.
  if (e.fromIgsid === account.igUserId) return;
  const t = await req.db.execute<{ id: string }>(sql`
    SELECT id FROM instagram_threads WHERE account_id = ${account.id} AND igsid = ${e.fromIgsid}`);
  const kept = await req.db.execute(sql`
    INSERT INTO instagram_comments
      (id, account_id, comment_id, media_id, media_type, parent_id, from_igsid, from_username, text, ad_id, live, at, thread_id)
    VALUES (${newId()}, ${account.id}, ${e.commentId}, ${e.mediaId}, ${e.mediaType}, ${e.parentId}, ${e.fromIgsid},
            ${e.fromUsername}, ${e.text}, ${e.adId}, ${e.live}, ${new Date(e.at)}, ${t.rows[0]?.id ?? null})
    ON CONFLICT (comment_id) DO NOTHING`);
  if (!kept.rowCount) return; // the same comment again: whatever it started, it started once
  await flowOnComment(
    req,
    account,
    {
      commentId: e.commentId,
      igsid: e.fromIgsid,
      username: e.fromUsername,
      mediaId: e.mediaId,
      adId: e.adId,
      text: e.text,
      live: e.live,
      at: new Date(e.at),
    },
    // Meta's 7 days for the private reply run on this server's clock, not the comment's (a gap caught up late).
    o.now,
    { publicRepliesPerHour: o.publicRepliesPerHour },
    out.flow,
  );
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
  new_dms: "team" | "ai" | null;
  username: string | null;
  token_enc: Buffer | null;
  automated_note: string | null;
  person_words: string[] | null;
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
            a.owner_user_id, a.run_as, a.source_id, a.new_dm_creates_lead, a.new_dms, a.username, a.token_enc,
            a.automated_note, a.person_words
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
    const moved = await pool.query<{ username: string }>(
      `UPDATE instagram_accounts SET status = 'needs_attention', problem = $2, updated_at = now()
        WHERE id = $1 AND status = 'active' RETURNING username`,
      [row.account_id, CANT_RUN],
    );
    // Said once, on the change: messages wait meanwhile (another admin connects the account again).
    if (moved.rows[0])
      await tellAdmins(pool, `Instagram @${moved.rows[0].username} needs connecting again`, CANT_RUN);
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
    newDms: row.new_dms ?? "team",
    runAs: row.run_as!,
    automatedNote: row.automated_note?.trim() || null,
    personWords: row.person_words ?? [],
    token: d.keyring.decrypt(row.token_enc, igTokenContext(row.account_id)),
  };

  // A person's message from someone LUME hasn't read the profile of: read now, before the transaction and its lock.
  let pre: GraphAnswer | null = null;
  if (ev.kind === "message" && !ev.isEcho) {
    const c = await pool.connect();
    let need = true;
    try {
      await c.query("BEGIN READ ONLY");
      await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
      const r = await c.query<{ read: boolean }>(
        "SELECT profile_read_at IS NOT NULL AS read FROM instagram_threads WHERE account_id = $1 AND igsid = $2",
        [account.id, ev.igsid],
      );
      await c.query("COMMIT");
      need = !r.rows[0]?.read;
    } finally {
      c.release();
    }
    if (need) pre = await igGraph(igGraphOf(d), account.token).profile(ev.igsid);
  }
  const out = await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `instagram-event:${eventId}`, allLeads: true },
    async (req): Promise<Out | null> => {
      const lock = await req.db.execute<{ status: string }>(
        sql`SELECT status FROM instagram_events WHERE id = ${eventId} FOR UPDATE`,
      );
      if (lock.rows[0]?.status !== "queued") return null;
      const out: Out = {
        autopilot: null,
        media: [],
        notice: null,
        profile: null,
        photo: null,
        later: false,
        flow: newFlowOut(),
        meaning: null,
      };
      const at = new Date(ev.at);
      switch (ev.kind) {
        case "message":
          if (ev.isEcho) await echo(req, account, ev, out);
          else await messageIn(req, d, account, ev, out, pre);
          break;
        case "postback": {
          const t = await threadFor(req, account.id, ev.igsid);
          await personActed(req, t.id, at, false);
          const leadId = await liveLead(req, t.lead_id);
          const payload = { tap: { title: ev.title, payload: ev.payload } };
          if (leadId && !(await onLeadAlready(req, leadId, ev.mid))) {
            const activityId = newId();
            // A tap on a flow's button is the person answering it. A tap is a button's words, never read for meaning.
            const took = await flowOnMessage(
              req,
              account,
              {
                threadId: t.id,
                leadId,
                text: ev.title,
                payload: ev.payload,
                via: "dm",
                first: false,
                adId: null,
              },
              at,
              out.flow,
            );
            await received(req, {
              id: activityId,
              leadId,
              userId: account.ownerUserId,
              at,
              payload: { mid: ev.mid, accountId: account.id, threadId: t.id, text: ev.title, ...payload },
              inFlow: took,
            });
          } else if (!leadId)
            await req.db.execute(sql`
              INSERT INTO instagram_inbox (id, thread_id, mid, at, text, detail)
              VALUES (${newId()}, ${t.id}, ${ev.mid}, ${at}, ${ev.title}, ${JSON.stringify(payload)}::jsonb)
              ON CONFLICT (mid) DO NOTHING`);
          break;
        }
        case "referral": {
          const t = await threadFor(req, account.id, ev.igsid);
          const ad = ev.referral.source?.toUpperCase() === "ADS";
          await personActed(req, t.id, at, ad);
          // The ad (or link) they came from, kept for the lead their first message makes.
          if (ad || ev.referral.ref)
            await req.db.execute(sql`
              UPDATE instagram_threads SET source = ${startKept(t.created)} || source || ${JSON.stringify({
                trigger: ad ? "ad" : "referral",
                ...(ev.referral.adId ? { adId: ev.referral.adId } : {}),
                ...(ev.referral.ref ? { ref: ev.referral.ref } : {}),
              })}::jsonb WHERE id = ${t.id} AND (source = '{}'::jsonb OR ${ad})`);
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
          await comment(req, account, ev, out, {
            now: d.clock(),
            publicRepliesPerHour: d.instagramLimits?.privateRepliesPerHour ?? IG_PUBLIC_REPLIES_PER_HOUR,
          });
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
  await afterFlow(o, out.flow);
  // LUME AI's conversation: answered (woken now), or, for a stop while it was LUME AI's, its one apology.
  if (out.autopilot) {
    const a = out.autopilot;
    if (a.stopped && a.running) await sendStopApology({ app: o.app, d }, a.runId, a.leadId);
    else if (a.ready)
      await tellPeople(pool, { runId: a.runId, leadId: a.leadId, kind: "ready", headline: "Replied" });
    else if (!a.stopped) await d.autopilot?.kick(a.runId).catch(() => undefined);
  }
  // New people turned away this hour: the admins hear once an hour, with what happens to them.
  if (
    out.flow.held &&
    row.account_id &&
    (await firstRefusal(pool, `lead:${row.account_id}`, hourOf(d.clock())))
  )
    await tellAdmins(
      pool,
      "Instagram: more new people than usual",
      `More new people wrote to @${row.username ?? "your account"} this hour than its limit for new leads. New DMs wait in Not a lead yet, and flows start for new people again next hour.`,
    ).catch((err: unknown) =>
      o.app.log.error({ err }, "couldn't tell the admins about Instagram's lead limit"),
    );
  for (const id of out.media)
    await d.instagram
      ?.enqueueMedia(id)
      .catch((err: unknown) => o.app.log.error({ err }, "couldn't queue an Instagram file"));
  if (out.profile)
    await d.instagram
      ?.enqueueProfile(out.profile)
      .catch((err: unknown) => o.app.log.error({ err }, "couldn't queue an Instagram profile read"));
  if (out.photo)
    await d.instagram
      ?.enqueuePhoto(out.photo)
      .catch((err: unknown) => o.app.log.error({ err }, "couldn't queue an Instagram profile photo"));
  // The same queue reads WhatsApp's replies: one read per reply, whichever channel it came on.
  if (out.meaning)
    await d.whatsapp
      ?.enqueueMeaning?.(out.meaning)
      .catch((err: unknown) => o.app.log.error({ err }, "couldn't queue a reply for LUME AI to read"));
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

/** How many times a delivery is tried before it's set aside with its reason (never every minute for ever). */
export const IG_EVENT_TRIES = 5;

/**
 * A delivery, processed: a failure is counted on the row, and the fifth is final ("error", with the fault's kind, never
 * its message, which can quote a person's words). The queue's own retry and the minute sweep only see queued rows.
 */
export async function runInstagramEvent(
  o: InstagramJobDeps,
  eventId: number,
): Promise<"done" | "waiting" | "gone" | "later"> {
  try {
    return await processInstagramEvent(o, eventId);
  } catch (err) {
    const pool = o.d.jobPool ?? o.d.pool;
    const kind = err instanceof Error ? err.name : "Error";
    await pool
      .query(
        `UPDATE instagram_events
            SET tries = tries + 1,
                status = CASE WHEN tries + 1 >= $2 THEN 'error' ELSE status END,
                problem = CASE WHEN tries + 1 >= $2 THEN $3 ELSE problem END,
                event_enc = CASE WHEN tries + 1 >= $2 THEN NULL ELSE event_enc END
          WHERE id = $1 AND status = 'queued'`,
        [eventId, IG_EVENT_TRIES, `LUME couldn't put this on a conversation (${kind})`],
      )
      .catch(() => undefined);
    o.app.log.error({ err, event: eventId }, "instagram event failed");
    throw err;
  }
}
