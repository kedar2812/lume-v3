import { refusalOfIg } from "@lume/core";
import { sha256Of, usedShare } from "../whatsapp/files";
import { DISK_STOP } from "../whatsapp/media";
import { igGraph } from "./graph";
import { downloadIg, IgFetch } from "./media";
import { IG_PHOTO_MAX, photoDue, photoMime } from "./photo";
import type { InstagramJobDeps } from "./process";
import { igGraphOf, igTokenContext } from "./service";
import { tokenRefused } from "./token-refresh";

type Row = { status: string; token_enc: Buffer | null; photo_checked_at: Date | null };

/**
 * The connected account's own profile photo (owner 2026-11-28), read with its token and kept as LUME's own copy, as a
 * lead's is (photo.ts): Meta's link is signed and expires, so it's never stored or shown. None from Meta drops the old
 * one; a link off Meta's hosts or bytes that aren't a photo leave it as it was; Meta down: "later". Written only if
 * nothing changed while Meta was asked (still active, no other look since): a disconnect meanwhile is never undone.
 */
export async function readAccountPhoto(o: InstagramJobDeps, accountId: string): Promise<"done" | "later"> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  const now = d.clock();
  const row = (
    await pool.query<Row>(
      "SELECT status, token_enc, photo_checked_at FROM instagram_accounts WHERE id = $1",
      [accountId],
    )
  ).rows[0];
  if (!row || row.status !== "active" || !row.token_enc) return "done";
  if (!photoDue(row.photo_checked_at, now)) return "done";
  if (!d.files) return "done";
  const disk = await d.files.disk();
  if (disk && usedShare(disk) >= DISK_STOP) return "done";

  const mark = (photo: { sha256: string; mime: string } | null | "keep") =>
    pool.query(
      `UPDATE instagram_accounts
          SET photo_sha256 = CASE WHEN $5 THEN photo_sha256 ELSE $2 END,
              photo_mime = CASE WHEN $5 THEN photo_mime ELSE $3 END,
              photo_checked_at = $4
        WHERE id = $1 AND status = 'active' AND photo_checked_at IS NOT DISTINCT FROM $6::timestamptz`,
      [
        accountId,
        photo === "keep" ? null : (photo?.sha256 ?? null),
        photo === "keep" ? null : (photo?.mime ?? null),
        now,
        photo === "keep",
        row.photo_checked_at,
      ],
    );

  const r = await igGraph(
    igGraphOf(d),
    d.keyring.decrypt(row.token_enc, igTokenContext(accountId)),
  ).accountPhoto();
  if (!r.ok) {
    const no = refusalOfIg(r.status, r.data);
    if (no.token) {
      await tokenRefused(pool, accountId);
      return "done";
    }
    if (no.retry || r.status === 0 || r.status >= 500) return "later";
    await mark("keep");
    return "done";
  }
  const url =
    typeof r.data.profile_picture_url === "string" && r.data.profile_picture_url
      ? r.data.profile_picture_url
      : null;
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
        { account: accountId },
        "instagram account photo link wasn't on Meta's hosts; not fetched",
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
  await pool.query(
    `INSERT INTO whatsapp_files (sha256, size) VALUES ($1, $2) ON CONFLICT (sha256) DO UPDATE SET last_ref_at = now()`,
    [sha256, got.bytes.length],
  );
  await pool.query("DELETE FROM whatsapp_files_gone WHERE sha256 = $1", [sha256]);
  try {
    await d.files.store.put(got.bytes);
  } catch (e) {
    const err = (e as NodeJS.ErrnoException).code ?? "";
    if (["ENOSPC", "EDQUOT", "EROFS", "EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(err)) return "done";
    throw e;
  }
  await mark({ sha256, mime });
  return "done";
}
