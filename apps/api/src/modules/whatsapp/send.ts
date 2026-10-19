import { canOnRecord, firstNameOf, moduleIncluded, newId } from "@lume/core";
import { schema } from "@lume/db";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { HttpError, badRequest } from "../../http/errors";
import { assertTaskOf, sendable } from "../leads/sending";
import type { LeadRow } from "../leads/serialize";
import { checkFile, keepBytes } from "./keep-bytes";
import { relayOf } from "./service";
import { messagesOf, type ThreadMessage } from "./thread";

/** WhatsApp's window for a free reply after the lead's last message (spec 2026-10-18 §3.4). */
const WINDOW_MS = 24 * 3_600_000;
const TEXT_MAX = 4096;
const CAPTION_MAX = 1024;

const conflict = (code: string, message: string) => new HttpError(409, code, message);
const windowClosed = (lead: LeadRow) => {
  const first = firstNameOf(lead.name ?? "") || "the lead";
  return conflict(
    "WINDOW_CLOSED",
    `It's been over 24 hours since ${first}'s last WhatsApp message. Send it from the phone, or wait for ${first} to write again.`,
  );
};

/**
 * A person's sends in a minute and an hour (plan W3a outcome 25): in memory, because one API process serves a
 * client's LUME. At most 10,000 people remembered, the least recent going first.
 */
export function sendLimiter(o: { now: () => Date; perMinute?: number; perHour?: number }) {
  const perMinute = o.perMinute ?? 30;
  const perHour = o.perHour ?? 600;
  const seen = new Map<string, number[]>();
  return {
    take(userId: string): { ok: true } | { ok: false; retryAfterSec: number } {
      const t = o.now().getTime();
      const times = (seen.get(userId) ?? []).filter((x) => t - x < 3_600_000);
      seen.delete(userId);
      const lastMinute = times.filter((x) => t - x < 60_000);
      if (lastMinute.length >= perMinute || times.length >= perHour) {
        seen.set(userId, times);
        const oldest = lastMinute.length >= perMinute ? lastMinute[0]! + 60_000 : times[0]! + 3_600_000;
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest - t) / 1000)) };
      }
      times.push(t);
      seen.set(userId, times);
      if (seen.size > 10_000) seen.delete(seen.keys().next().value!);
      return { ok: true };
    },
  };
}
export type SendLimiter = ReturnType<typeof sendLimiter>;

/** Whether replying from LUME is on here: WhatsApp on, the admin's switch on, set up, and in the plan. */
async function replyOn(req: FastifyRequest, d: AppDeps): Promise<boolean> {
  if (!relayOf(d) || !d.meta || !moduleIncluded(req.server.licence.view().plan, "whatsapp")) return false;
  const [s] = await req.db
    .select({ i: schema.settings.integrations })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  return !!s?.i.whatsapp?.enabled && !!s.i.whatsapp.replyFromLume;
}

type ReplyNumber = { id: string; display: string; status: string; ownerName: string | null };
/**
 * The lead's last WhatsApp message to the business, and the number it came to: a reply goes from that number, and
 * only within 24 hours of it.
 */
async function lastInbound(
  req: FastifyRequest,
  leadId: string,
): Promise<{ at: Date; number: ReplyNumber | null } | null> {
  const r = await req.db.execute<{
    at: Date;
    id: string | null;
    display: string | null;
    status: string | null;
    owner: string | null;
  }>(sql`
    SELECT a.occurred_at AS at, n.id, n.display_phone AS display, n.status, u.name AS owner
      FROM activities a
      LEFT JOIN whatsapp_numbers n ON n.id = (a.payload->>'numberId')::uuid
      LEFT JOIN users u ON u.id = n.owner_user_id
     WHERE a.lead_id = ${leadId} AND a.type = 'whatsapp_received'
     ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1`);
  const row = r.rows[0];
  if (!row) return null;
  return {
    at: new Date(row.at),
    number: row.id ? { id: row.id, display: row.display!, status: row.status!, ownerName: row.owner } : null,
  };
}
const notReady = (n: ReplyNumber) =>
  conflict(
    "NUMBER_NOT_READY",
    n.status === "disconnected"
      ? `${n.display} isn't connected any more. Connect it again to reply from LUME.`
      : `Connect ${n.display} again to reply from LUME.`,
  );

/** Everything that decides whether this person may reply to this lead now, and from which number. */
async function replyRoute(req: FastifyRequest, d: AppDeps, lead: LeadRow) {
  const last = await lastInbound(req, lead.id);
  if (!last?.number) throw windowClosed(lead);
  const until = new Date(last.at.getTime() + WINDOW_MS);
  if (until <= d.clock()) throw windowClosed(lead);
  if (last.number.status !== "active") throw notReady(last.number);
  return { number: last.number, until };
}

export type ReplyState = {
  allowed: boolean;
  number: { id: string; display: string; ownerName: string | null } | null;
  until: string | null;
  reason: string | null;
} | null;

/** For the lead's WhatsApp tab: null when there's no composer (off here, or this person can't message the lead). */
export async function replyState(req: FastifyRequest, d: AppDeps, lead: LeadRow): Promise<ReplyState> {
  if (!(await replyOn(req, d)) || !canOnRecord(req.actor!, "messages.send", lead.ownerId)) return null;
  try {
    const { number, until } = await replyRoute(req, d, lead);
    return {
      allowed: true,
      number: { id: number.id, display: number.display, ownerName: number.ownerName },
      until: until.toISOString(),
      reason: null,
    };
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    const last = await lastInbound(req, lead.id);
    const n = e.code === "NUMBER_NOT_READY" ? last?.number : null;
    return {
      allowed: false,
      number: n ? { id: n.id, display: n.display, ownerName: n.ownerName } : null,
      until: n && last ? new Date(last.at.getTime() + WINDOW_MS).toISOString() : null,
      reason: e.message,
    };
  }
}

async function mayReply(req: FastifyRequest, d: AppDeps, leadId: string) {
  if (!(await replyOn(req, d)))
    throw conflict(
      "REPLY_OFF",
      "Replying from LUME is off. An admin can switch it on in Settings → Integrations → WhatsApp.",
    );
  const lead = await sendable(req, leadId);
  return { lead, ...(await replyRoute(req, d, lead)) };
}

/**
 * A file attached in the composer (plan W3a outcomes 12–17): what it really is from its bytes, within WhatsApp's
 * size for that kind, kept once on this server as a draft of this lead by this person until it's sent.
 */
export async function attachFile(
  req: FastifyRequest,
  d: AppDeps,
  leadId: string,
  bytes: Buffer,
  filename: string | null,
) {
  const { lead, number } = await mayReply(req, d, leadId);
  const type = checkFile(bytes, filename);
  const sha256 = await keepBytes(req, d, bytes);
  const id = newId();
  const name = filename?.trim().slice(0, 200) || null;
  await req.db.insert(schema.whatsappMedia).values({
    id,
    numberId: number.id,
    metaId: `lume:${id}`,
    leadId: lead.id,
    kind: type.kind,
    mime: type.mime,
    filename: type.kind === "document" ? name : null,
    voice: false,
    size: bytes.length,
    sha256,
    status: "ready",
    draft: true,
    uploadedBy: req.actor!.userId,
  });
  return {
    media: {
      id,
      kind: type.kind,
      mime: type.mime,
      filename: type.kind === "document" ? name : null,
      size: bytes.length,
    },
  };
}

/**
 * A reply from LUME (plan W3a): checked now (the switch, permission, the 24 hours, the number, the limits), kept as a
 * queued message on the lead's thread, and sent by the queue once this request has committed. The same `clientKey`
 * from the same person is the same message, however many times it arrives.
 */
export async function sendReply(
  req: FastifyRequest,
  d: AppDeps,
  limiter: SendLimiter,
  leadId: string,
  body: {
    clientKey: string;
    text?: string | undefined;
    mediaId?: string | undefined;
    taskId?: string | undefined;
  },
): Promise<{ message: ThreadMessage }> {
  const O = schema.whatsappOutbox;
  const me = req.actor!.userId;
  const again = async () => {
    const [prior] = await req.db
      .select({ activityId: O.activityId, leadId: O.leadId })
      .from(O)
      .where(and(eq(O.userId, me), eq(O.clientKey, body.clientKey)));
    if (!prior?.activityId) return null;
    if (prior.leadId !== leadId)
      throw badRequest("KEY_REUSED", "That message was already sent to another lead.");
    const [m] = await messagesOf(req, [prior.activityId]);
    return m ? { message: m } : null;
  };
  const prior = await again();
  if (prior) return prior;

  const { lead, number } = await mayReply(req, d, leadId);
  const text = body.text ?? "";
  if (!text.trim() && !body.mediaId) throw badRequest("EMPTY", "Write a message, or attach a file.");
  let media: { id: string; kind: string; mime: string; filename: string | null } | null = null;
  if (body.mediaId) {
    const M = schema.whatsappMedia;
    const [m] = await req.db
      .select({ id: M.id, kind: M.kind, mime: M.mime, filename: M.filename })
      .from(M)
      .where(
        and(
          eq(M.id, body.mediaId),
          eq(M.leadId, lead.id),
          eq(M.draft, true),
          eq(M.uploadedBy, me),
          eq(M.status, "ready"),
        ),
      );
    if (!m) throw badRequest("BAD_FILE", "That file isn't attached here any more. Attach it again.");
    if (m.kind === "audio" && text.trim())
      throw badRequest(
        "AUDIO_NO_TEXT",
        "A voice note goes without words. Send the words as their own message.",
      );
    if (text.length > CAPTION_MAX)
      throw badRequest("TOO_LONG", "Words with a file can be up to 1,024 characters.");
    media = m;
  } else if (text.length > TEXT_MAX)
    throw badRequest("TOO_LONG", "WhatsApp messages can be up to 4,096 characters.");
  if (body.taskId) await assertTaskOf(req, lead.id, body.taskId);

  const verdict = limiter.take(me);
  if (!verdict.ok)
    throw new HttpError(429, "TOO_MANY", "That's a lot of messages at once. Wait a minute and send again.", {
      retryAfterSec: verdict.retryAfterSec,
    });

  const outboxId = newId();
  const activityId = newId();
  // Under a savepoint: the same key arriving twice at once is one message (the second finds the first).
  await req.db.execute(sql`SAVEPOINT lume_reply`);
  try {
    await req.db.insert(O).values({
      id: outboxId,
      leadId: lead.id,
      numberId: number.id,
      userId: me,
      activityId,
      clientKey: body.clientKey,
      text: text || null,
      mediaId: media?.id ?? null,
      taskId: body.taskId ?? null,
      status: "queued",
    });
    await req.db.execute(sql`RELEASE SAVEPOINT lume_reply`);
  } catch (e) {
    await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_reply`);
    if ((e as { code?: string }).code !== "23505") throw e;
    const first = await again();
    if (first) return first;
    throw e;
  }
  await req.db.insert(schema.activities).values({
    id: activityId,
    leadId: lead.id,
    userId: me,
    type: "whatsapp_sent",
    occurredAt: d.clock(),
    payload: {
      text: text || null,
      numberId: number.id,
      outboxId,
      via: "lume",
      ...(media ? { media: { ...media, voice: false } } : {}),
    },
  });
  if (media)
    await req.db
      .update(schema.whatsappMedia)
      .set({ draft: false })
      .where(eq(schema.whatsappMedia.id, media.id));
  req.afterCommit(() => void d.whatsapp?.enqueueSend(outboxId));
  const [message] = await messagesOf(req, [activityId]);
  return { message: message! };
}
