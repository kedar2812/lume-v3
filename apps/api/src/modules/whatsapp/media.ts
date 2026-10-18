import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { schema } from "@lume/db";
import { eq } from "drizzle-orm";
import { notFound } from "../../http/errors";
import { MetaError, metaClient } from "./meta";
import type { WhatsAppJobDeps } from "./process";
import { tokenContext } from "./service";

const RECONNECT = "WhatsApp stopped letting LUME in. Connect this number again.";
const WORDS = {
  too_large: "This file is over 25 MB. Open it on the phone.",
  not_found: "WhatsApp no longer has this file.",
  waiting_token: "Waiting for this number to be connected again.",
  failed: "LUME couldn't fetch this file from WhatsApp.",
};
const TRIES = 3;

/** A transaction that sees every lead (media rows follow their lead's visibility): background work only. */
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

/**
 * One photo, voice note, video or document, fetched with its number's own token to this server (spec 2026-10-18
 * §4.1): Meta's links expire, so LUME keeps the file. Over 25 MB it isn't kept and says so. A token WhatsApp no longer
 * accepts puts the number in "needs attention" and the file waits; a passing failure is tried again (3 times).
 */
export async function fetchMedia(o: WhatsAppJobDeps, id: string): Promise<void> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  const row = await allScope(
    pool,
    async (c) =>
      (
        await c.query<{
          status: string;
          meta_id: string;
          tries: number;
          number_id: string;
          token_enc: Buffer | null;
        }>(
          `SELECT m.status, m.meta_id, m.tries, n.id AS number_id, n.token_enc
           FROM whatsapp_media m JOIN whatsapp_numbers n ON n.id = m.number_id WHERE m.id = $1`,
          [id],
        )
      ).rows[0],
  );
  if (!row || row.status !== "waiting" || !d.meta) return;
  const set = (fields: {
    status: string;
    problem: string | null;
    data?: Buffer;
    size?: number;
    tries?: number;
  }) =>
    allScope(pool, (c) =>
      c.query(
        `UPDATE whatsapp_media SET status = $2, problem = $3, data = $4, size = coalesce($5, size), tries = coalesce($6, tries)
          WHERE id = $1`,
        [id, fields.status, fields.problem, fields.data ?? null, fields.size ?? null, fields.tries ?? null],
      ),
    );
  if (!row.token_enc) return void (await set({ status: "waiting", problem: WORDS.waiting_token }));
  const meta = metaClient(d.meta, d.keyring.decrypt(row.token_enc, tokenContext(row.number_id)));
  try {
    const m = await meta.media(row.meta_id);
    const bytes = await meta.download(m.url);
    await set({ status: "ready", problem: null, data: bytes, size: bytes.length });
  } catch (e) {
    if (!(e instanceof MetaError)) throw e;
    if (e.kind === "too_large") return void (await set({ status: "too_large", problem: WORDS.too_large }));
    if (e.kind === "not_found") return void (await set({ status: "failed", problem: WORDS.not_found }));
    if (e.kind === "token") {
      await pool.query(
        "UPDATE whatsapp_numbers SET status = 'needs_attention', problem = $2, updated_at = now() WHERE id = $1 AND status = 'active'",
        [row.number_id, RECONNECT],
      );
      return void (await set({ status: "waiting", problem: WORDS.waiting_token }));
    }
    const tries = row.tries + 1;
    if (tries >= TRIES) return void (await set({ status: "failed", problem: WORDS.failed, tries }));
    await set({ status: "waiting", problem: null, tries });
    throw e; // the queue tries again later
  }
}

const M = schema.whatsappMedia;
/** A media item this person may see (row-level security decides), or 404. */
async function visibleMedia(req: FastifyRequest, id: string) {
  const [m] = await req.db
    .select({
      status: M.status,
      problem: M.problem,
      kind: M.kind,
      mime: M.mime,
      filename: M.filename,
      size: M.size,
      voice: M.voice,
    })
    .from(M)
    .where(eq(M.id, id));
  if (!m) throw notFound("MEDIA_NOT_FOUND", "That file isn't here.");
  return m;
}

/** What a file is and whether it's here yet, for the thread. */
export async function mediaInfo(req: FastifyRequest, id: string) {
  return visibleMedia(req, id);
}

/** The file itself: shown in place for photos, audio and video; a download with its name for documents. */
export async function sendMedia(req: FastifyRequest, reply: FastifyReply, id: string) {
  await visibleMedia(req, id);
  const [m] = await req.db
    .select({ data: M.data, mime: M.mime, kind: M.kind, filename: M.filename, status: M.status })
    .from(M)
    .where(eq(M.id, id));
  if (!m || m.status !== "ready" || !m.data) throw notFound("MEDIA_NOT_READY", "That file isn't here yet.");
  const inline = m.kind !== "document";
  const name = (m.filename ?? `whatsapp-${m.kind}`).replace(/["\\\r\n]/g, "");
  return reply
    .header("content-type", m.mime)
    .header(
      "content-disposition",
      inline ? "inline" : `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    )
    .header("x-content-type-options", "nosniff")
    .header("cache-control", "private, max-age=86400")
    .send(m.data);
}
