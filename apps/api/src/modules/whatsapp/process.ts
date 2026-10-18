import { can, newId, type WaEvent } from "@lume/core";
import { schema } from "@lume/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { loadActor } from "../../rbac/actor";
import { jobServer, withJobRequest } from "../imports/job-request";
import { visibleLead } from "../leads/service";
import { confirmSend, replyArrived } from "../leads/sending";
import { readAs } from "../notifications/hub";
import { notify } from "../notifications/notify";
import { eventContext } from "./receive";

export type WhatsAppJobDeps = { app: FastifyInstance; d: AppDeps };

const PREVIEW = 120;
const CANT_RUN = "Whoever connected this number can't see leads any more. Connect it again.";
const MEDIA_WORDS: Record<NonNullable<WaEvent["media"]>["kind"], string> = {
  image: "Sent a photo",
  audio: "Sent a voice note",
  video: "Sent a video",
  document: "Sent a document",
  sticker: "Sent a sticker",
};
const firstName = (n: string | null) => n?.trim().split(/\s+/)[0] || null;
/** What a message said, for a notice: its words, or what it was. */
export const gist = (ev: Pick<WaEvent, "text" | "media">) =>
  (ev.text?.slice(0, PREVIEW) ??
    (ev.media
      ? ev.media.kind === "audio" && !ev.media.voice
        ? "Sent an audio file"
        : MEDIA_WORDS[ev.media.kind]
      : "")) ||
  "Sent a message";

/**
 * Which lead a WhatsApp number belongs to (spec 2026-10-18 §4.1): of the leads with that number, the number owner's own
 * first, then the most recently active — one lead, never two. Runs with every lead in scope.
 */
export async function matchLead(
  req: FastifyRequest,
  peer: string,
  ownerUserId: string | null,
): Promise<string | null> {
  const r = await req.db.execute<{ id: string }>(sql`
    SELECT id FROM leads
     WHERE phone_e164 = ${peer} AND deleted_at IS NULL
     ORDER BY (${ownerUserId}::uuid IS NOT NULL AND owner_id = ${ownerUserId}::uuid) DESC,
              coalesce(last_activity_at, created_at) DESC, created_at DESC
     LIMIT 1`);
  return r.rows[0]?.id ?? null;
}

async function addMedia(
  req: FastifyRequest,
  numberId: string,
  m: NonNullable<WaEvent["media"]>,
  where: { leadId: string } | { inboxId: string },
): Promise<string> {
  const id = newId();
  await req.db.insert(schema.whatsappMedia).values({
    id,
    numberId,
    metaId: m.id,
    ...("leadId" in where ? { leadId: where.leadId } : { inboxId: where.inboxId }),
    kind: m.kind,
    mime: m.mime,
    filename: m.filename,
    voice: m.voice,
    status: "waiting",
  });
  return id;
}

type Row = {
  status: string;
  event_enc: Buffer | null;
  wamid: string;
  kind: string;
  number_id: string | null;
  owner_user_id: string | null;
  run_as: string | null;
  number_status: string | null;
};

/**
 * One WhatsApp event into LUME (spec 2026-10-18 §4.1–4.2): on the matched lead as `whatsapp_received` /
 * `whatsapp_sent` at the message's own time (the same message is there once, however it came: live, retried, or in
 * past chats); a live reply also does what tapping "They replied" does and tells the lead's owner; a live message
 * from the phone answers a pending "Sent?". A stranger's message waits in "Not a lead yet"; nothing else about
 * strangers is kept. Runs as the person who connected the number, seeing every lead.
 */
export async function processWhatsAppEvent(
  o: WhatsAppJobDeps,
  eventId: number,
): Promise<"done" | "waiting" | "gone"> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  const { rows } = await pool.query<Row>(
    `SELECT e.status, e.event_enc, e.wamid, e.kind, n.id AS number_id, n.owner_user_id, n.run_as, n.status AS number_status
       FROM whatsapp_events e LEFT JOIN whatsapp_numbers n ON n.phone_number_id = e.phone_number_id
      WHERE e.id = $1`,
    [eventId],
  );
  const row = rows[0];
  if (!row || row.status !== "queued" || !row.event_enc) return "gone";
  const finish = () =>
    pool.query(
      "UPDATE whatsapp_events SET status = 'done', event_enc = NULL, processed_at = now() WHERE id = $1",
      [eventId],
    );
  if (!row.number_id || row.number_status === "disconnected") {
    await finish();
    return "gone";
  }
  const actor = await loadActor(pool, row.run_as!);
  if (!actor || !can(actor, "leads.view")) {
    await pool.query(
      "UPDATE whatsapp_numbers SET status = 'needs_attention', problem = $2, updated_at = now() WHERE id = $1",
      [row.number_id, CANT_RUN],
    );
    return "waiting";
  }
  const ev = JSON.parse(d.keyring.decrypt(row.event_enc, eventContext(row.wamid, row.kind))) as WaEvent;
  const numberId = row.number_id;
  const live = ev.kind === "received" || ev.kind === "sent";

  const out = await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `whatsapp-event:${eventId}`, allLeads: true },
    async (req) => {
      const lock = await req.db.execute<{ status: string }>(
        sql`SELECT status FROM whatsapp_events WHERE id = ${eventId} FOR UPDATE`,
      );
      if (lock.rows[0]?.status !== "queued") return null;
      const media: string[] = [];
      let notice: { ownerId: string; leadId: string; title: string } | null = null;
      let answer: { leadId: string; opener: string } | null = null;
      const leadId = await matchLead(req, ev.peer, row.owner_user_id);
      if (leadId) {
        const dup = await req.db.execute(sql`
          SELECT 1 FROM activities
           WHERE lead_id = ${leadId} AND type IN ('whatsapp_received', 'whatsapp_sent') AND payload->>'wamid' = ${ev.wamid}
           LIMIT 1`);
        if (!dup.rows.length) {
          const mediaId = ev.media ? await addMedia(req, numberId, ev.media, { leadId }) : null;
          if (mediaId) media.push(mediaId);
          const received = ev.kind === "received" || ev.kind === "history_received";
          const at = new Date(ev.at);
          await req.db.insert(schema.activities).values({
            id: newId(),
            leadId,
            userId: row.owner_user_id,
            type: received ? "whatsapp_received" : "whatsapp_sent",
            occurredAt: at,
            payload: {
              text: ev.text,
              wamid: ev.wamid,
              numberId,
              ...(ev.media && mediaId
                ? {
                    media: {
                      id: mediaId,
                      kind: ev.media.kind,
                      mime: ev.media.mime,
                      filename: ev.media.filename,
                      voice: ev.media.voice,
                    },
                  }
                : {}),
              ...(ev.name ? { name: ev.name } : {}),
            },
          });
          const col = received ? sql`last_reply_at` : sql`last_message_at`;
          await req.db.execute(sql`
            UPDATE leads SET ${col} = GREATEST(coalesce(${col}, ${at}), ${at}),
                             last_activity_at = GREATEST(coalesce(last_activity_at, ${at}), ${at})
             WHERE id = ${leadId}`);
          const lead = await visibleLead(req, leadId);
          if (ev.kind === "received") {
            // As tapping "They replied" does: the stage's reply move, and repeats waiting on a reply stop.
            await replyArrived(req, lead);
            if (lead.ownerId)
              notice = {
                ownerId: lead.ownerId,
                leadId,
                title: `${firstName(lead.name) ?? "A lead"} replied on WhatsApp`,
              };
          }
          if (ev.kind === "sent") {
            // The newest "Sent?" on this lead opened in the last 24 hours: whoever opened it gets it answered.
            const opened = await req.db.execute<{ user_id: string }>(sql`
              SELECT user_id FROM activities
               WHERE lead_id = ${leadId} AND type = 'whatsapp_opened' AND user_id IS NOT NULL
                 AND occurred_at > ${new Date(ev.at)}::timestamptz - interval '24 hours'
               ORDER BY occurred_at DESC, id DESC LIMIT 1`);
            if (opened.rows[0]) answer = { leadId, opener: opened.rows[0].user_id };
          }
        }
      } else if (ev.kind === "received") {
        const ignored = await req.db.execute(
          sql`SELECT 1 FROM whatsapp_ignored WHERE number_id = ${numberId} AND peer = ${ev.peer}`,
        );
        if (!ignored.rows.length) {
          const inboxId = newId();
          const kept = await req.db
            .insert(schema.whatsappInbox)
            .values({
              id: inboxId,
              numberId,
              peer: ev.peer,
              name: ev.name,
              wamid: ev.wamid,
              at: new Date(ev.at),
              text: ev.text,
            })
            .onConflictDoNothing({ target: schema.whatsappInbox.wamid })
            .returning({ id: schema.whatsappInbox.id });
          if (kept.length && ev.media) {
            const mediaId = await addMedia(req, numberId, ev.media, { inboxId });
            media.push(mediaId);
            await req.db.execute(sql`UPDATE whatsapp_inbox SET media_id = ${mediaId} WHERE id = ${inboxId}`);
          }
        }
      }
      // Strangers' messages from the phone, and strangers' past chats, are not kept (§4.1).
      await req.db.execute(
        sql`UPDATE whatsapp_events SET status = 'done', event_enc = NULL, processed_at = now() WHERE id = ${eventId}`,
      );
      return { media, notice, answer };
    },
  );
  if (!out) return "gone";

  for (const id of out.media)
    await d.whatsapp
      ?.enqueueMedia(id)
      .catch((err: unknown) => o.app.log.error({ err }, "couldn't queue a WhatsApp file"));
  if (out.notice && live) {
    const n = out.notice;
    // One notice for a burst: several messages in a row from one lead ring once.
    // Notices are their recipient's own (row-level security): looked at as them.
    const recent = await readAs(pool, n.ownerId, (c) =>
      c.query(
        `SELECT 1 FROM notifications WHERE user_id = $1 AND lead_id = $2 AND kind = 'lead_replied'
            AND created_at > now() - interval '10 minutes' LIMIT 1`,
        [n.ownerId, n.leadId],
      ),
    );
    if (!recent.rows.length)
      await notify(pool, n.ownerId, {
        kind: "lead_replied",
        title: n.title,
        body: gist(ev),
        leadId: n.leadId,
      }).catch((err: unknown) =>
        o.app.log.warn({ err }, "couldn't tell a lead's owner about a WhatsApp reply"),
      );
  }
  if (out.answer) await answerSent(o, out.answer.leadId, out.answer.opener);
  return "done";
}

/**
 * A message sent from the phone answers the newest "Sent?" on that lead opened in the last 24 hours, as the person
 * who opened it (spec §4.1): nobody taps "Yes, sent" again. Said once: an answered one stays answered.
 */
async function answerSent(o: WhatsAppJobDeps, leadId: string, openerId: string) {
  const pool = o.d.jobPool ?? o.d.pool;
  const opener = await loadActor(pool, openerId);
  if (!opener) return;
  await withJobRequest(
    { app: jobServer(o.app), pool, actor: opener, requestId: `whatsapp-echo:${leadId}`, allLeads: false },
    (req) => confirmSend(req, o.d, leadId, { sent: true }, { via: "echo" }),
  ).catch((err: unknown) =>
    o.app.log.warn({ err }, "couldn't answer Sent? from a message sent on the phone"),
  );
}
