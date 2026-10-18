import { newId } from "@lume/core";
import { schema } from "@lume/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { notFound } from "../../http/errors";
import { createLead } from "../leads/service";

const I = schema.whatsappInbox;
const N = schema.whatsappNumbers;
const INBOX_DAYS = 14;
const EVENTS_DAYS = 30;

/** "Not a lead yet" (spec 2026-10-18 §4.1): one row per person, newest first. Row-level security decides who sees. */
export async function inboxView(req: FastifyRequest) {
  const r = await req.db.execute<{
    peer: string;
    name: string | null;
    number_id: string;
    display: string;
    count: number;
    last_text: string | null;
    last_at: Date;
  }>(sql`
    SELECT i.peer, (array_agg(i.name ORDER BY i.at DESC) FILTER (WHERE i.name IS NOT NULL))[1] AS name,
           i.number_id, n.display_phone AS display, count(*)::int AS count,
           (array_agg(i.text ORDER BY i.at DESC))[1] AS last_text, max(i.at) AS last_at
      FROM whatsapp_inbox i JOIN whatsapp_numbers n ON n.id = i.number_id
     GROUP BY i.peer, i.number_id, n.display_phone
     ORDER BY max(i.at) DESC`);
  return {
    people: r.rows.map((x) => ({
      peer: x.peer,
      name: x.name,
      number: { id: x.number_id, display: x.display },
      count: x.count,
      lastText: x.last_text,
      lastAt: new Date(x.last_at).toISOString(),
    })),
  };
}

async function messagesOf(req: FastifyRequest, numberId: string, peer: string) {
  const rows = await req.db
    .select({ id: I.id, wamid: I.wamid, at: I.at, text: I.text, name: I.name, mediaId: I.mediaId })
    .from(I)
    .where(and(eq(I.numberId, numberId), eq(I.peer, peer)))
    .orderBy(asc(I.at));
  if (!rows.length) throw notFound("NOT_IN_INBOX", "Nothing from this number is waiting here.");
  return rows;
}

/** One person's messages, oldest first. */
export async function inboxPerson(req: FastifyRequest, numberId: string, peer: string) {
  const rows = await messagesOf(req, numberId, peer);
  return {
    messages: rows.map((m) => ({ id: m.id, at: m.at.toISOString(), text: m.text, mediaId: m.mediaId })),
  };
}

/**
 * Make it an enquiry: a lead with their WhatsApp name (or the number), the number as its phone, owned as the number
 * is (a person's number: that person; the business's: unassigned), and their messages on it. They wait no more.
 */
export async function makeLead(req: FastifyRequest, numberId: string, peer: string) {
  const rows = await messagesOf(req, numberId, peer);
  const [n] = await req.db.select({ owner: N.ownerUserId }).from(N).where(eq(N.id, numberId));
  const name = rows.findLast((m) => m.name)?.name ?? peer;
  const { lead } = await createLead(req, { name, phone: peer, ownerId: n?.owner ?? null });
  for (const m of rows) {
    // A file keeps what it is (a photo stays a photo on the lead).
    const [f] = m.mediaId
      ? await req.db
          .select({
            kind: schema.whatsappMedia.kind,
            mime: schema.whatsappMedia.mime,
            filename: schema.whatsappMedia.filename,
            voice: schema.whatsappMedia.voice,
          })
          .from(schema.whatsappMedia)
          .where(eq(schema.whatsappMedia.id, m.mediaId))
      : [];
    await req.db.insert(schema.activities).values({
      id: newId(),
      leadId: lead.id,
      userId: n?.owner ?? null,
      type: "whatsapp_received",
      occurredAt: m.at,
      payload: {
        text: m.text,
        wamid: m.wamid,
        numberId,
        ...(m.name ? { name: m.name } : {}),
        ...(m.mediaId ? { media: { id: m.mediaId, ...(f ?? {}) } } : {}),
      },
    });
    if (m.mediaId)
      await req.db
        .update(schema.whatsappMedia)
        .set({ leadId: lead.id, inboxId: null })
        .where(eq(schema.whatsappMedia.id, m.mediaId));
  }
  const last = rows.at(-1)!.at;
  await req.db.execute(sql`UPDATE leads SET last_reply_at = ${last} WHERE id = ${lead.id}`);
  await req.db.delete(I).where(and(eq(I.numberId, numberId), eq(I.peer, peer)));
  return { leadId: lead.id };
}

/** Not a lead: their messages go, and that number never shows up again here. */
export async function ignorePeer(req: FastifyRequest, numberId: string, peer: string) {
  await messagesOf(req, numberId, peer);
  await req.db.insert(schema.whatsappIgnored).values({ numberId, peer }).onConflictDoNothing();
  await req.db.delete(I).where(and(eq(I.numberId, numberId), eq(I.peer, peer)));
  return { ignored: true as const };
}

/** Hourly: strangers kept 14 days, processed events (their bodies long gone) 30. */
export async function sweepWhatsApp(pool: pg.Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    await c.query("DELETE FROM whatsapp_inbox WHERE created_at < now() - make_interval(days => $1)", [
      INBOX_DAYS,
    ]);
    await c.query(
      `DELETE FROM whatsapp_media WHERE lead_id IS NULL AND inbox_id IS NULL
          AND created_at < now() - make_interval(days => $1)`,
      [INBOX_DAYS],
    );
    await c.query(
      "DELETE FROM whatsapp_events WHERE status <> 'queued' AND received_at < now() - make_interval(days => $1)",
      [EVENTS_DAYS],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
