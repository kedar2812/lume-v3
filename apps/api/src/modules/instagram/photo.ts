import type pg from "pg";
import { refusalOfIg } from "@lume/core";
import { sha256Of, usedShare } from "../whatsapp/files";
import { DISK_STOP } from "../whatsapp/media";
import { igGraph } from "./graph";
import { downloadIg, IgFetch } from "./media";
import type { InstagramJobDeps } from "./process";
import { igGraphOf, igTokenContext } from "./service";
import { tokenRefused } from "./token-refresh";

/** A profile photo is small: anything bigger isn't one (Meta's are well under 1 MB). */
export const IG_PHOTO_MAX = 5 * 1024 * 1024;
/** Meta's "User consent is required to access user profile": no photo to show. */
const IG_NO_CONSENT = 230;
/** How long a check holds: the person's next message after this asks Meta again. */
export const IG_PHOTO_EVERY_MS = 7 * 86_400_000;

/** Whether a conversation's photo is due a look: never checked, or checked a week or more ago. */
export function photoDue(checkedAt: Date | string | null, now: Date): boolean {
  return !checkedAt || now.getTime() - new Date(checkedAt).getTime() >= IG_PHOTO_EVERY_MS;
}

/** What the bytes are, read from the bytes (never a header): JPEG, PNG or WebP, nothing else (no SVG, no pages). */
export function photoMime(b: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP")
    return "image/webp";
  return null;
}

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
  igsid: string;
  photo_checked_at: Date | null;
  lead_id: string | null;
  account_id: string;
  status: string;
  token_enc: Buffer | null;
};

/**
 * A person's profile photo, read once they've written (Meta gives it then, and only then) and kept as LUME's own copy:
 * Meta's link is signed and expires, so it's never shown or stored. None from Meta (privacy, or not allowed) drops the
 * old one; a link off Meta's hosts, bytes that aren't a photo, or one over 5 MB leave the old one as it was. Meta
 * down or asking LUME to slow down: "later" (the queue tries again), with nothing marked; any other refusal keeps the
 * old one. Nothing is fetched for an account that isn't connected, or with nowhere to keep the file.
 */
export async function readInstagramPhoto(o: InstagramJobDeps, threadId: string): Promise<"done" | "later"> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  const now = d.clock();
  const row = await allScope(
    pool,
    async (c) =>
      (
        await c.query<Row>(
          `SELECT t.igsid, t.photo_checked_at, t.lead_id, a.id AS account_id, a.status, a.token_enc
             FROM instagram_threads t JOIN instagram_accounts a ON a.id = t.account_id WHERE t.id = $1`,
          [threadId],
        )
      ).rows[0],
  );
  if (!row || row.status !== "active" || !row.token_enc) return "done";
  if (!photoDue(row.photo_checked_at, now)) return "done"; // looked at already (a burst queues one look)
  if (!d.files) return "done";
  const disk = await d.files.disk();
  if (disk && usedShare(disk) >= DISK_STOP) return "done";

  // Written only if nothing changed while Meta was asked (up to a minute): the account still connected, the same
  // lead, and no other look since. A data deletion request or a purge meanwhile is never undone; a second job for the
  // same person writes nothing.
  const mark = (photo: { sha256: string; mime: string } | null | "keep") =>
    allScope(pool, (c) =>
      c.query(
        `UPDATE instagram_threads t
            SET photo_sha256 = CASE WHEN $5 THEN t.photo_sha256 ELSE $2 END,
                photo_mime = CASE WHEN $5 THEN t.photo_mime ELSE $3 END,
                photo_checked_at = $4
           FROM instagram_accounts a
          WHERE t.id = $1 AND a.id = t.account_id AND a.status = 'active'
            AND t.lead_id IS NOT DISTINCT FROM $6::uuid
            AND t.photo_checked_at IS NOT DISTINCT FROM $7::timestamptz`,
        [
          threadId,
          photo === "keep" ? null : (photo?.sha256 ?? null),
          photo === "keep" ? null : (photo?.mime ?? null),
          now,
          photo === "keep",
          row.lead_id,
          row.photo_checked_at,
        ],
      ),
    );

  const r = await igGraph(
    igGraphOf(d),
    d.keyring.decrypt(row.token_enc, igTokenContext(row.account_id)),
  ).photo(row.igsid);
  if (!r.ok) {
    const no = refusalOfIg(r.status, r.data);
    if (no.token) {
      await tokenRefused(pool, row.account_id);
      return "done";
    }
    // Meta down (any 5xx, whatever its code) or busy (a burst of new people): asked again later, the photo as it was.
    if (no.retry || r.status === 0 || r.status >= 500) return "later";
    // Meta won't show their profile (consent): no photo. Any other refusal says nothing about the photo: kept.
    const code = (r.data.error as { code?: unknown } | undefined)?.code;
    await mark(code === IG_NO_CONSENT ? null : "keep");
    return "done";
  }
  const url = typeof r.data.profile_pic === "string" && r.data.profile_pic ? r.data.profile_pic : null;
  if (!url) {
    await mark(null);
    return "done";
  }

  let got: { bytes: Buffer };
  try {
    got = await downloadIg(url, d.instagramGraph?.graphUrl ?? "https://graph.instagram.com", IG_PHOTO_MAX);
  } catch (e) {
    if (!(e instanceof IgFetch)) throw e;
    if (e.kind === "failed") return "later";
    if (e.kind === "untrusted")
      o.app.log.warn(
        { thread: threadId },
        "instagram profile photo link wasn't on Meta's hosts; not fetched",
      );
    await mark("keep");
    return "done";
  }
  const mime = photoMime(got.bytes);
  if (!mime) {
    await mark("keep");
    return "done";
  }
  const sha256 = sha256Of(got.bytes);
  // The file's row first, touched now: the hourly sweep spares a file touched within the hour.
  await allScope(pool, async (c) => {
    await c.query(
      `INSERT INTO whatsapp_files (sha256, size) VALUES ($1, $2) ON CONFLICT (sha256) DO UPDATE SET last_ref_at = now()`,
      [sha256, got.bytes.length],
    );
    await c.query("DELETE FROM whatsapp_files_gone WHERE sha256 = $1", [sha256]);
  });
  try {
    await d.files.store.put(got.bytes);
  } catch (e) {
    const err = (e as NodeJS.ErrnoException).code ?? "";
    // Nowhere to keep it (a full disk, a folder LUME can't write): asked again at their next message.
    if (["ENOSPC", "EDQUOT", "EROFS", "EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(err)) return "done";
    throw e;
  }
  await mark({ sha256, mime });
  return "done";
}
