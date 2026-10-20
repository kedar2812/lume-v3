import { readFile } from "node:fs/promises";
import type { AppDeps } from "../../app";
import { sha256Of, usedShare } from "../whatsapp/files";
import { DISK_STOP } from "../whatsapp/media";
import type { Sniffed } from "../whatsapp/sniff";

/*
 * Media's previews (plan 2026-10-20-media-tab, Task 4): what LUME shows of a file before it's opened. Made once per
 * file's bytes by the render service (apps/render), kept in the shared store like any file, and held by file_previews
 * (0080). The upload never waits for one: it's queued after the file is saved, and a render service that's slow or
 * down only means a tile shows the file's kind a little longer.
 */

export type ViewAs = "image" | "video" | "audio" | "pdf" | "office" | "sheet" | "text";
export type PreviewState = "pending" | "ready" | "none" | "failed";

const SHEETS = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
const OFFICE = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
]);

/** How LUME's viewer shows a file, from what its bytes said it is (sniff.ts). */
export function viewAsOf(kind: Sniffed["kind"], mime: string): ViewAs {
  if (kind !== "document") return kind;
  if (mime === "application/pdf") return "pdf";
  if (SHEETS.has(mime)) return "sheet";
  if (OFFICE.has(mime)) return "office";
  return "text";
}

/** Whether a file of this kind has a preview at all: a voice note has nothing to show. */
export const hasPreview = (viewAs: ViewAs) => viewAs !== "audio";

/** How many times a preview is tried before it's left failed (an admin can try again from the viewer). */
export const PREVIEW_TRIES = 3;
/** How long one call to the render service may take: its own limit is 45 s a tool, and a job may wait its turn. */
const RENDER_TIMEOUT_MS = 90_000;
/** How long a preview may wait without a job before the sweep queues it again. */
const STALE_MS = 10 * 60_000;

type Answer = { bytes: Buffer; headers: Headers };
/** The render service couldn't (422, a broken file) or wouldn't (413, 415): trying again won't change it. */
class Refused extends Error {}

async function ask(d: AppDeps, path: string, bytes: Buffer, type: string): Promise<Answer> {
  const r = await fetch(`${d.render!.url}${path}`, {
    method: "POST",
    body: bytes,
    headers: { "content-type": type },
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  });
  const body = Buffer.from(await r.arrayBuffer());
  if (r.status === 413 || r.status === 415) throw new Refused(`render answered ${r.status}`);
  if (!r.ok) throw new Error(`render answered ${r.status}: ${body.toString().slice(0, 200)}`);
  return { bytes: body, headers: r.headers };
}

const isWebp = (b: Buffer) =>
  b.length > 12 &&
  b.subarray(0, 4).toString("latin1") === "RIFF" &&
  b.subarray(8, 12).toString("latin1") === "WEBP";
const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";
const intOf = (h: Headers, name: string) => {
  const n = Number(h.get(name));
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
};

/**
 * Bytes the render service made, kept in the shared store: the row first (touched now, so the hourly sweep spares it
 * until the preview holds it), then the file. A full disk is a reason to try later, not a failure.
 */
async function keep(d: AppDeps, bytes: Buffer): Promise<string> {
  const files = d.files!;
  const disk = await files.disk();
  if (disk && usedShare(disk) >= DISK_STOP) throw new Error("the disk is full");
  const sha256 = sha256Of(bytes);
  const pool = d.jobPool ?? d.pool;
  await pool.query(
    `INSERT INTO whatsapp_files (sha256, size) VALUES ($1, $2)
     ON CONFLICT (sha256) DO UPDATE SET last_ref_at = now()`,
    [sha256, bytes.length],
  );
  await pool.query("DELETE FROM whatsapp_files_gone WHERE sha256 = $1", [sha256]);
  await files.store.put(bytes);
  return sha256;
}

/** A preview's changes, each only while it's still waiting (an admin's Try again, a second job, can't be undone). */
const SET = {
  none: "UPDATE file_previews SET state = 'none', updated_at = $2 WHERE sha256 = $1 AND state = 'pending'",
  tried: "UPDATE file_previews SET tries = $3, updated_at = $2 WHERE sha256 = $1 AND state = 'pending'",
  failed:
    "UPDATE file_previews SET state = 'failed', updated_at = $2 WHERE sha256 = $1 AND state = 'pending'",
  ready: `UPDATE file_previews SET state = 'ready', thumb_sha256 = $3, pdf_sha256 = $4, pages = $5, duration_ms = $6,
            width = $7, height = $8, updated_at = $2
          WHERE sha256 = $1 AND state = 'pending'`,
} as const;

/**
 * Make one file's preview. "ready" or "none": done. "failed": the render service couldn't, or its tries are spent.
 * "retry": the service was down, busy or slow, or the disk full; the queue tries again later (pg-boss's backoff).
 */
export async function makePreview(
  d: AppDeps,
  sha256: string,
): Promise<"ready" | "none" | "failed" | "retry"> {
  const pool = d.jobPool ?? d.pool;
  const { rows } = await pool.query<{
    state: PreviewState;
    tries: number;
    kind: Sniffed["kind"];
    mime: string;
  }>(
    `SELECT p.state, p.tries, f.kind, f.mime FROM file_previews p
       JOIN LATERAL (SELECT kind, mime FROM message_files WHERE sha256 = p.sha256 LIMIT 1) f ON true
      WHERE p.sha256 = $1`,
    [sha256],
  );
  const row = rows[0];
  if (!row) return "none"; // nothing in the library has these bytes any more
  if (row.state !== "pending") return row.state;
  const viewAs = viewAsOf(row.kind, row.mime);
  const set = (to: keyof typeof SET, params: unknown[] = []) =>
    pool.query(SET[to], [sha256, d.clock(), ...params]);
  if (!d.render || !d.files || !hasPreview(viewAs)) {
    await set("none");
    return "none";
  }
  const tries = row.tries + 1;
  await set("tried", [tries]);
  try {
    const bytes = await readFile(d.files.store.path(sha256));
    // Office and text files are read through their PDF; only Word's and PowerPoint's is kept, to page through.
    let source: { bytes: Buffer; type: string } = { bytes, type: row.mime };
    let pdfSha: string | null = null;
    if (viewAs === "office" || viewAs === "sheet" || viewAs === "text") {
      const pdf = await ask(d, "/v1/pdf", bytes, row.mime);
      if (!isPdf(pdf.bytes)) throw new Refused("render's PDF isn't a PDF");
      if (viewAs === "office") pdfSha = await keep(d, pdf.bytes);
      source = { bytes: pdf.bytes, type: "application/pdf" };
    }
    const thumb = await ask(d, "/v1/thumb", source.bytes, source.type);
    if (!isWebp(thumb.bytes)) throw new Refused("render's thumbnail isn't a WebP");
    const thumbSha = await keep(d, thumb.bytes);
    await set("ready", [
      thumbSha,
      pdfSha,
      intOf(thumb.headers, "x-pages"),
      intOf(thumb.headers, "x-duration-ms"),
      intOf(thumb.headers, "x-width"),
      intOf(thumb.headers, "x-height"),
    ]);
    return "ready";
  } catch (e) {
    const last = e instanceof Refused || tries >= PREVIEW_TRIES;
    if (last) await set("failed");
    return last ? "failed" : "retry";
  }
}

/**
 * Every 15 minutes: library files with no preview yet (added before Media), previews a lost job left waiting, and,
 * on a server that has just been given a render service, files that had none because there wasn't one. Those found
 * are marked a day old, so the one look for waiting previews queues them at once. Returns the hashes queued.
 */
export async function sweepPreviews(d: AppDeps): Promise<string[]> {
  const pool = d.jobPool ?? d.pool;
  const now = d.clock();
  await pool.query(
    `INSERT INTO file_previews (sha256, updated_at)
     SELECT DISTINCT sha256, $1::timestamptz - interval '1 day' FROM message_files
     ON CONFLICT (sha256) DO NOTHING`,
    [now],
  );
  if (d.render)
    await pool.query(
      `UPDATE file_previews p SET state = 'pending', tries = 0, updated_at = $1::timestamptz - interval '1 day'
        WHERE p.state = 'none'
          AND EXISTS (SELECT 1 FROM message_files f WHERE f.sha256 = p.sha256 AND f.kind <> 'audio')`,
      [now],
    );
  const { rows } = await pool.query<{ sha256: string }>(
    `SELECT sha256 FROM file_previews
      WHERE state = 'pending' AND updated_at < $1::timestamptz - make_interval(secs => $2)
      ORDER BY updated_at LIMIT 500`,
    [now, STALE_MS / 1000],
  );
  for (const r of rows) await d.media?.enqueuePreview(r.sha256);
  return rows.map((r) => r.sha256);
}
