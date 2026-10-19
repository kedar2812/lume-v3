import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { schema } from "@lume/db";
import { eq } from "drizzle-orm";
import type { AppDeps } from "../../app";
import { notFound } from "../../http/errors";
import { sha256Of, usedShare } from "./files";
import { MetaError, metaClient } from "./meta";
import type { WhatsAppJobDeps } from "./process";
import { tokenContext } from "./service";

const RECONNECT = "WhatsApp stopped letting LUME in. Connect this number again.";
export const MEDIA_WORDS = {
  too_large: "This file is over 25 MB. Open it on the phone.",
  not_found: "WhatsApp no longer has this file.",
  waiting_token: "Waiting for this number to be connected again.",
  failed: "LUME couldn't fetch this file from WhatsApp.",
  disk_full: "The server's disk is full. LUME will try again.",
  cant_save: "LUME can't save files on this server yet. It will try again.",
  strangers: "LUME didn't keep this file. Too many files came today from people who aren't leads.",
  untrusted: "LUME didn't fetch this file. WhatsApp sent a link that isn't Meta's.",
  missing: "This file isn't on the server any more. It's still on the phone.",
};
const TRIES = 3;
/** Past this share of the disk in use, no new file is kept: Postgres must never be the one that runs out of room. */
export const DISK_STOP = 0.95;
/**
 * Files from numbers no lead has, kept in a day at most for each connected number: strangers can't fill the disk, and
 * a team with a hundred numbers gets a hundred times the room (a flat cap would turn real enquiries away).
 */
export const STRANGERS_PER_DAY = 1024 ** 3;
/** How long a file that couldn't be kept (disk full, folder not writable) waits before it's tried again. */
const RETRY_MS = 15 * 60_000;

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

const diskErrors = new Set(["ENOSPC", "EDQUOT"]);
const writeErrors = new Set(["EROFS", "EACCES", "EPERM", "ENOENT", "ENOTDIR"]);

/**
 * One photo, voice note, video or document, fetched with its number's own token and kept on this server's disk, once
 * however many media point at the same bytes (spec 2026-10-18 §4.1; files out of the database, 2026-10-19). Over
 * 25 MB it isn't kept and says so. A token WhatsApp no longer accepts puts the number in "needs attention" and the file
 * waits; a passing failure is tried again (3 times). A full disk, or a folder LUME can't write, makes it wait 15
 * minutes without using a try.
 */
export async function fetchMedia(o: WhatsAppJobDeps, id: string): Promise<void> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  const now = d.clock();
  const row = await allScope(
    pool,
    async (c) =>
      (
        await c.query<{
          status: string;
          meta_id: string;
          tries: number;
          number_id: string;
          lead_id: string | null;
          retry_at: Date | null;
          token_enc: Buffer | null;
        }>(
          `SELECT m.status, m.meta_id, m.tries, m.lead_id, m.retry_at, n.id AS number_id, n.token_enc
           FROM whatsapp_media m JOIN whatsapp_numbers n ON n.id = m.number_id WHERE m.id = $1`,
          [id],
        )
      ).rows[0],
  );
  if (!row || row.status !== "waiting" || !d.meta) return;
  if (row.retry_at && row.retry_at > now) return; // the sweep brings it back when it's time
  const set = (f: {
    status: string;
    problem: string | null;
    sha256?: string;
    size?: number;
    tries?: number;
    retryAt?: Date;
  }) =>
    allScope(pool, (c) =>
      c.query(
        `UPDATE whatsapp_media SET status = $2, problem = $3, sha256 = $4, size = coalesce($5, size),
                tries = coalesce($6, tries), retry_at = $7
          WHERE id = $1 AND status = 'waiting'`,
        [id, f.status, f.problem, f.sha256 ?? null, f.size ?? null, f.tries ?? null, f.retryAt ?? null],
      ),
    );
  const later = (problem: string) =>
    set({ status: "waiting", problem, retryAt: new Date(now.getTime() + RETRY_MS) });
  if (!row.token_enc) return void (await set({ status: "waiting", problem: MEDIA_WORDS.waiting_token }));
  if (!d.files) return void (await later(MEDIA_WORDS.cant_save));
  const disk = await d.files.disk();
  if (disk && usedShare(disk) >= DISK_STOP) return void (await later(MEDIA_WORDS.disk_full));

  const meta = metaClient(d.meta, d.keyring.decrypt(row.token_enc, tokenContext(row.number_id)));
  let bytes: Buffer;
  try {
    const m = await meta.media(row.meta_id);
    bytes = await meta.download(m.url);
  } catch (e) {
    if (!(e instanceof MetaError)) throw e;
    if (e.kind === "too_large")
      return void (await set({ status: "too_large", problem: MEDIA_WORDS.too_large }));
    if (e.kind === "not_found") return void (await set({ status: "failed", problem: MEDIA_WORDS.not_found }));
    if (e.kind === "untrusted") {
      o.app.log.warn({ media: id }, "whatsapp media link wasn't on Meta's hosts; not fetched");
      return void (await set({ status: "failed", problem: MEDIA_WORDS.untrusted }));
    }
    if (e.kind === "token") {
      await pool.query(
        "UPDATE whatsapp_numbers SET status = 'needs_attention', problem = $2, updated_at = now() WHERE id = $1 AND status = 'active'",
        [row.number_id, RECONNECT],
      );
      return void (await set({ status: "waiting", problem: MEDIA_WORDS.waiting_token }));
    }
    const tries = row.tries + 1;
    if (tries >= TRIES) return void (await set({ status: "failed", problem: MEDIA_WORDS.failed, tries }));
    await set({ status: "waiting", problem: null, tries });
    throw e; // the queue tries again later
  }

  const sha256 = sha256Of(bytes);
  if (!row.lead_id) {
    // A stranger's file: only so much a day for this number (a file LUME already has costs nothing).
    const { kept, have } = await allScope(pool, async (c) => {
      const k = await c.query<{ bytes: string }>(
        `SELECT coalesce(sum(size), 0) AS bytes FROM whatsapp_media
          WHERE number_id = $2 AND lead_id IS NULL AND status = 'ready'
            AND created_at > $1::timestamptz - interval '24 hours'`,
        [now, row.number_id],
      );
      const h = await c.query("SELECT 1 FROM whatsapp_files WHERE sha256 = $1", [sha256]);
      return { kept: Number(k.rows[0]?.bytes ?? 0), have: (h.rowCount ?? 0) > 0 };
    });
    if (!have && kept + bytes.length > STRANGERS_PER_DAY)
      return void (await set({ status: "failed", problem: MEDIA_WORDS.strangers }));
  }
  // The file's row first, touched now: the hourly sweep spares a file touched within the hour, so it can't remove
  // this one between the write below and the media pointing at it. A file that had gone is back.
  await allScope(pool, async (c) => {
    await c.query(
      `INSERT INTO whatsapp_files (sha256, size) VALUES ($1, $2)
       ON CONFLICT (sha256) DO UPDATE SET last_ref_at = now()`,
      [sha256, bytes.length],
    );
    await c.query("DELETE FROM whatsapp_files_gone WHERE sha256 = $1", [sha256]);
  });
  try {
    await d.files.store.put(bytes);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (diskErrors.has(code)) return void (await later(MEDIA_WORDS.disk_full));
    if (writeErrors.has(code)) {
      o.app.log.error({ media: id, code }, "LUME can't write WhatsApp files");
      return void (await later(MEDIA_WORDS.cant_save));
    }
    throw e;
  }
  await set({ status: "ready", problem: null, sha256, size: bytes.length });
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
      sha256: M.sha256,
    })
    .from(M)
    .where(eq(M.id, id));
  if (!m) throw notFound("MEDIA_NOT_FOUND", "That file isn't here.");
  return m;
}

const onDisk = async (d: AppDeps, sha256: string | null) => {
  if (!sha256 || !d.files) return null;
  const s = await stat(d.files.store.path(sha256)).catch(() => null);
  return s?.isFile() ? { path: d.files.store.path(sha256), size: s.size } : null;
};

/** What a file is and whether it's here, for the thread. A file the database has but the disk doesn't: "missing". */
export async function mediaInfo(req: FastifyRequest, d: AppDeps, id: string) {
  const { sha256, ...m } = await visibleMedia(req, id);
  if (m.status === "ready" && !(await onDisk(d, sha256)))
    return { ...m, status: "missing" as const, problem: MEDIA_WORDS.missing };
  return m;
}

/** Shown in place on LUME's own page only when it's one of these: never HTML, SVG, XML or script. */
const INLINE = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/3gpp",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "audio/opus",
]);
/** Kept as they are on a download; anything else downloads as plain bytes. */
const DOWNLOAD = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
]);
const baseMime = (mime: string) => mime.split(";")[0]!.trim().toLowerCase();

/** One byte range, as browsers ask for video and voice notes: [start, end], "bad", or null for the whole file. */
export function byteRange(header: string | undefined, size: number): [number, number] | "bad" | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "") || size === 0) return "bad";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (!(n > 0)) return "bad";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    return "bad";
  return [start, end];
}

/**
 * The file itself, from this server's disk: photos, voice notes and video in place (with byte ranges, which Safari
 * needs to play them); documents and anything not on the list above as a download with its name. Every answer is
 * sandboxed and never sniffed, so a file a stranger sent can't run as a page of LUME's.
 */
export async function sendMedia(req: FastifyRequest, reply: FastifyReply, d: AppDeps, id: string) {
  const m = await visibleMedia(req, id);
  if (m.status !== "ready") throw notFound("MEDIA_NOT_READY", "That file isn't here yet.");
  const file = await onDisk(d, m.sha256);
  if (!file) throw notFound("MEDIA_MISSING", MEDIA_WORDS.missing);
  const base = baseMime(m.mime);
  const inline = m.kind !== "document" && INLINE.has(base);
  const type = inline || DOWNLOAD.has(base) ? base : "application/octet-stream";
  const name =
    (m.filename ?? `whatsapp-${m.kind}`).replace(/["\\\r\n]/g, "").slice(0, 200) || "whatsapp-file";
  const range = byteRange(typeof req.headers.range === "string" ? req.headers.range : undefined, file.size);
  if (range === "bad")
    return reply
      .code(416)
      .header("content-range", `bytes */${file.size}`)
      .send({ error: { code: "RANGE_NOT_SATISFIABLE", message: "That part of the file doesn't exist." } });
  const etag = `"${m.sha256}"`;
  reply
    .header("content-type", type)
    .header(
      "content-disposition",
      inline
        ? "inline"
        : `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    )
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("cache-control", "private, max-age=86400")
    .header("etag", etag)
    .header("accept-ranges", "bytes");
  if (req.headers["if-none-match"] === etag) return reply.code(304).send();
  if (range) {
    const [start, end] = range;
    return reply
      .code(206)
      .header("content-range", `bytes ${start}-${end}/${file.size}`)
      .header("content-length", String(end - start + 1))
      .send(createReadStream(file.path, { start, end }));
  }
  return reply.header("content-length", String(file.size)).send(createReadStream(file.path));
}
