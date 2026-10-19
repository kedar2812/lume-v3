import { readFile } from "node:fs/promises";
import { canOnRecord, outboundBody, refusalOf, type WaStatus } from "@lume/core";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { loadActor } from "../../rbac/actor";
import { jobServer, withJobRequest } from "../imports/job-request";
import { countSend } from "../leads/sending";
import { recordActivity, visibleLead } from "../leads/service";
import { HttpError } from "../../http/errors";
import { MetaError, metaClient } from "./meta";
import type { WhatsAppJobDeps } from "./process";
import { tokenContext } from "./service";

/** A message that has been "sending" this long was cut short somewhere: never sent again (it may have gone). */
const SENDING_STUCK_MS = 2 * 60_000;
/** Meta's ids for uploaded files last 30 days: reused for 25. */
const UPLOAD_KEEP_MS = 25 * 86_400_000;
/** Tries of a passing refusal (busy, rate limited) before it's failed with words. */
export const SEND_TRIES = 5;
const MAYBE_SENT = "LUME couldn't tell whether this went. Check the phone before sending it again.";

/** A transaction that sees every lead: background work only. */
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
  /** "sending" untouched for 2 minutes, by the database's clock. */
  stuck: boolean;
  tries: number;
  text: string | null;
  task_id: string | null;
  user_id: string;
  user_name: string | null;
  lead_id: string;
  lead_deleted: boolean;
  lead_phone: string | null;
  number_id: string;
  phone_number_id: string;
  number_status: string;
  display_phone: string;
  token_enc: Buffer | null;
  media_kind: "image" | "video" | "audio" | "document" | null;
  media_mime: string | null;
  media_filename: string | null;
  media_sha: string | null;
};

/**
 * Send one reply from LUME (plan W3a outcomes 7–9, 14, 21–24). Run by the `whatsapp.send` queue; a throw means "try
 * again later" (pg-boss's backoff), anything else is final.
 *
 * - Never twice: the message is marked `sending` (committed) before Meta is called, and one found `sending` for over
 *   2 minutes is failed with words, never sent again; it may have gone.
 * - Sent as the person who tapped Send: if they can't message the lead any more, or the lead went to the bin, it
 *   isn't sent.
 * - A file is uploaded to Meta once per number and content, its id reused for 25 days; an id Meta no longer has is
 *   dropped and the file uploaded again, once.
 * - Once Meta takes it, it counts as a send, as that person: the lead's last message, first contact, the follow-up
 *   done, the stage's move.
 */
export async function sendOutbox(o: WhatsAppJobDeps, id: string): Promise<void> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  const row = await allScope(
    pool,
    async (c) =>
      (
        await c.query<Row>(
          `SELECT o.status, o.updated_at < now() - make_interval(secs => $2) AS stuck, o.tries, o.text, o.task_id, o.user_id, u.name AS user_name, o.lead_id,
                  l.deleted_at IS NOT NULL AS lead_deleted, l.phone_e164 AS lead_phone,
                  n.id AS number_id, n.phone_number_id, n.status AS number_status, n.display_phone, n.token_enc,
                  m.kind AS media_kind, m.mime AS media_mime, m.filename AS media_filename, m.sha256 AS media_sha
             FROM whatsapp_outbox o
             JOIN leads l ON l.id = o.lead_id
             JOIN whatsapp_numbers n ON n.id = o.number_id
             LEFT JOIN users u ON u.id = o.user_id
             LEFT JOIN whatsapp_media m ON m.id = o.media_id
            WHERE o.id = $1`,
          [id, SENDING_STUCK_MS / 1000],
        )
      ).rows[0],
  );
  if (!row) return;
  const set = (status: string, f: { problem?: string | null; wamid?: string; tries?: number } = {}) =>
    allScope(pool, (c) =>
      c.query(
        `UPDATE whatsapp_outbox SET status = $2, problem = $3, wamid = coalesce($4, wamid),
                tries = coalesce($5, tries), updated_at = now()
          WHERE id = $1`,
        [id, status, f.problem ?? null, f.wamid ?? null, f.tries ?? null],
      ),
    );
  const fail = (problem: string) => set("failed", { problem });
  if (row.status === "sending") {
    if (row.stuck) await fail(MAYBE_SENT);
    return;
  }
  if (row.status !== "queued") return;
  if (row.lead_deleted) return void (await fail("This lead isn't here any more."));
  if (row.number_status !== "active" || !row.token_enc)
    return void (await fail(`Connect ${row.display_phone} again to reply from LUME.`));
  if (!row.lead_phone) return void (await fail("This lead has no WhatsApp number."));
  if (!d.meta) return void (await fail("WhatsApp isn't set up on this server."));

  // The sender, as they are now: someone who can't message this lead any more doesn't send to it.
  const actor = await loadActor(pool, row.user_id);
  const who = row.user_name?.trim() || "This person";
  const lost = `${who} can't message this lead any more.`;
  if (!actor) return void (await fail(lost));
  const allowed = await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `whatsapp-send:${id}`, allLeads: false },
    async (req) => {
      const lead = await visibleLead(req, row.lead_id).catch((e: unknown) => {
        if (e instanceof HttpError) return null;
        throw e;
      });
      return !!lead && canOnRecord(actor, "messages.send", lead.ownerId);
    },
  );
  if (!allowed) return void (await fail(lost));

  const tries = row.tries + 1;
  await set("sending", { tries });
  const meta = metaClient(d.meta, d.keyring.decrypt(row.token_enc, tokenContext(row.number_id)));
  let wamid: string;
  try {
    const first = await bodyOf(o, row, meta, false);
    try {
      wamid = await meta.sendMessage(row.phone_number_id, first.body);
    } catch (e) {
      // A reused file id Meta no longer has (131053): dropped, the file uploaded again, and sent once more.
      if (!first.reused || !(e instanceof MetaError) || e.code !== 131053) throw e;
      await pool.query("DELETE FROM whatsapp_meta_uploads WHERE number_id = $1 AND sha256 = $2", [
        row.number_id,
        row.media_sha,
      ]);
      wamid = await meta.sendMessage(row.phone_number_id, (await bodyOf(o, row, meta, true)).body);
    }
  } catch (e) {
    if (e instanceof MissingFile)
      return void (await fail("This file isn't on the server any more. Attach it again."));
    if (!(e instanceof MetaError)) {
      await set("queued");
      throw e;
    }
    const why = refusalOf(e.kind === "token" ? 190 : e.code);
    if (why.token)
      await pool.query(
        "UPDATE whatsapp_numbers SET status = 'needs_attention', problem = $2, updated_at = now() WHERE id = $1 AND status = 'active'",
        [row.number_id, "WhatsApp stopped letting LUME in. Connect this number again."],
      );
    if (why.retry && tries < SEND_TRIES) {
      await set("queued");
      throw e; // the queue tries again later, with backoff
    }
    // Meta's error codes only: never its message text, which can quote the request.
    o.app.log.warn({ outbox: id, code: e.code }, "whatsapp reply refused");
    return void (await fail(why.words));
  }

  // Meta took it: it's sent (its id on the outbox, which an echo of it is matched by), and it counts as a send, as
  // the person who sent it.
  await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `whatsapp-sent:${id}`, allLeads: true },
    async (req) => {
      await req.db.execute(sql`
        UPDATE whatsapp_outbox SET status = 'sent', wamid = ${wamid}, problem = NULL, updated_at = now()
         WHERE id = ${id} AND status = 'sending'`);
      const lead = await visibleLead(req, row.lead_id);
      await recordActivity(req, lead.id, "whatsapp_confirmed_sent", { via: "lume", outboxId: id });
      await countSend(req, d, lead, row.task_id ?? undefined);
    },
  );
}

class MissingFile extends Error {}

/**
 * What to send: the words, or the file by Meta's id with its caption. The id is reused when this number uploaded the
 * same file in the last 25 days (`reused`), unless `fresh` asks for a new upload.
 */
async function bodyOf(
  o: WhatsAppJobDeps,
  row: Row,
  meta: ReturnType<typeof metaClient>,
  fresh: boolean,
): Promise<{ body: Record<string, unknown>; reused: boolean }> {
  const to = row.lead_phone!;
  if (!row.media_kind) return { body: outboundBody(to, { text: row.text ?? "" }), reused: false };
  if (!row.media_sha || !o.d.files) throw new MissingFile();
  const pool = o.d.jobPool ?? o.d.pool;
  const file = {
    kind: row.media_kind,
    ...(row.text ? { caption: row.text } : {}),
    ...(row.media_filename ? { filename: row.media_filename } : {}),
  };
  if (!fresh) {
    const cached = await pool.query<{ meta_media_id: string }>(
      "SELECT meta_media_id FROM whatsapp_meta_uploads WHERE number_id = $1 AND sha256 = $2 AND uploaded_at > $3",
      [row.number_id, row.media_sha, new Date(o.d.clock().getTime() - UPLOAD_KEEP_MS)],
    );
    const reused = cached.rows[0]?.meta_media_id;
    if (reused) return { body: outboundBody(to, { ...file, mediaId: reused }), reused: true };
  }
  const bytes = await readFile(o.d.files.store.path(row.media_sha)).catch(() => {
    throw new MissingFile();
  });
  const mediaId = await meta.uploadMedia(
    row.phone_number_id,
    bytes,
    row.media_mime ?? "application/octet-stream",
    row.media_filename ?? `file.${row.media_kind}`,
  );
  await pool.query(
    `INSERT INTO whatsapp_meta_uploads (number_id, sha256, meta_media_id, uploaded_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (number_id, sha256) DO UPDATE SET meta_media_id = excluded.meta_media_id, uploaded_at = excluded.uploaded_at`,
    [row.number_id, row.media_sha, mediaId, o.d.clock()],
  );
  return { body: outboundBody(to, { ...file, mediaId }), reused: false };
}

/**
 * Meta's delivery statuses for replies LUME sent (plan W3a outcomes 18–20): forward only (queued, sending, sent,
 * delivered, read); a failure counts only before delivery; a status for a message LUME didn't send is nothing.
 */
export async function applyStatuses(pool: pg.Pool, statuses: WaStatus[]): Promise<void> {
  if (!statuses.length) return;
  await allScope(pool, async (c) => {
    for (const s of statuses)
      await c.query(
        `UPDATE whatsapp_outbox o SET status = $2, problem = $3, updated_at = now()
          WHERE o.wamid = $1
            AND o.number_id IN (SELECT id FROM whatsapp_numbers WHERE phone_number_id = $4)
            AND CASE
                  WHEN $2 = 'failed' THEN o.status IN ('queued', 'sending', 'sent')
                  ELSE o.status <> 'failed' AND
                       (CASE o.status WHEN 'queued' THEN 0 WHEN 'sending' THEN 1 WHEN 'sent' THEN 2
                                      WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 END)
                       < (CASE $2 WHEN 'sent' THEN 2 WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 END)
                END`,
        [s.wamid, s.status, s.status === "failed" ? refusalOf(s.errorCode).words : null, s.phoneNumberId],
      );
  });
}
