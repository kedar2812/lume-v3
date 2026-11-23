import type pg from "pg";
import { DISK_STOP } from "../whatsapp/media";
import { sha256Of, usedShare } from "../whatsapp/files";
import { bytesSpent, dayOf, firstRefusal, spendBytes } from "./budgets";
import { tellAdmins } from "./service";
import type { InstagramJobDeps } from "./process";

/** At most what Meta sends: 25 MB (Send API limits, read 2026-11-22). */
export const IG_MEDIA_MAX = 25 * 1024 * 1024;
const TRIES = 3;
const RETRY_MS = 15 * 60_000;
/** Where Instagram serves what people send: Meta's own CDN hosts only. */
const HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net|fbsbx\.com|facebook\.com|instagram\.com)$/;
const WORDS = {
  too_large: "This file is over 25 MB, so LUME didn't keep it. It's still in Instagram.",
  failed: "LUME couldn't fetch this file from Instagram. It's still in Instagram.",
  untrusted: "Instagram sent a link that isn't Meta's, so LUME didn't open it.",
  gone: "Instagram no longer has this file.",
  disk_full: "The server's disk is full. LUME will try again.",
  cant_save: "LUME can't save files on this server yet.",
  over_limit:
    "LUME didn't keep this file: today's files from Instagram reached their limit. It's still in Instagram.",
};
const MB = 1024 * 1024;

/**
 * Whether a link may be fetched: https on Meta's own hosts (Instagram's links carry their own signature, so no token is
 * ever sent), or the configured Graph API's origin (the fake, in tests). Anything else could make this server fetch
 * from inside its own network.
 */
export function trustedIgUrl(url: string, graphUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.origin === new URL(graphUrl).origin) return true;
  return u.protocol === "https:" && HOSTS.test(u.hostname);
}

export class IgFetch extends Error {
  constructor(readonly kind: "too_large" | "gone" | "untrusted" | "failed") {
    super(kind);
  }
}

/** A file from Meta's hosts only (redirects checked too), never more than `max` bytes read. */
export async function downloadIg(
  url: string,
  graphUrl: string,
  max = IG_MEDIA_MAX,
): Promise<{ bytes: Buffer; type: string | null }> {
  if (!trustedIgUrl(url, graphUrl)) throw new IgFetch("untrusted");
  const first = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) }).catch(
    () => null,
  );
  if (!first) throw new IgFetch("failed");
  let r = first;
  // A redirect is followed only to Meta's hosts.
  if (first.status >= 300 && first.status < 400) {
    const to = first.headers.get("location");
    const next = to ? new URL(to, url).toString() : "";
    if (!next || !trustedIgUrl(next, graphUrl)) throw new IgFetch("untrusted");
    const again = await fetch(next, { redirect: "error", signal: AbortSignal.timeout(30_000) }).catch(
      () => null,
    );
    if (!again) throw new IgFetch("failed");
    r = again;
  }
  if (r.status === 404 || r.status === 410 || r.status === 403) throw new IgFetch("gone");
  if (!r.ok || !r.body) throw new IgFetch("failed");
  if (Number(r.headers.get("content-length") ?? 0) > max) throw new IgFetch("too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of r.body as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > max) throw new IgFetch("too_large");
    chunks.push(Buffer.from(c));
  }
  return { bytes: Buffer.concat(chunks), type: r.headers.get("content-type") };
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

/**
 * One photo, video, voice note or file a person sent, kept on this server's disk once however many messages point at
 * the same bytes (the files store WhatsApp's media use). Meta's links expire within days, so it's fetched at once.
 * Over 25 MB, or gone from Meta, it says so and isn't tried again; a passing failure is tried 3 times; a full disk or
 * a folder LUME can't write makes it wait 15 minutes without using a try.
 */
export async function fetchInstagramMedia(o: InstagramJobDeps, id: string): Promise<void> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  const now = d.clock();
  const graphUrl = d.instagramGraph?.graphUrl ?? "https://graph.instagram.com";
  const row = await allScope(
    pool,
    async (c) =>
      (
        await c.query<{
          status: string;
          url: string;
          tries: number;
          retry_at: Date | null;
          account_id: string;
          thread_id: string;
          person_mb: number;
          account_mb: number;
          counted: boolean;
          username: string;
        }>(
          `SELECT m.status, m.url, m.tries, m.retry_at, m.account_id, m.thread_id, m.counted, a.username,
                  a.media_mb_per_person_day AS person_mb, a.media_mb_per_day AS account_mb
             FROM instagram_media m JOIN instagram_accounts a ON a.id = m.account_id WHERE m.id = $1`,
          [id],
        )
      ).rows[0],
  );
  if (!row || row.status !== "waiting") return;
  if (row.retry_at && row.retry_at > now) return;
  const set = (f: {
    status: string;
    problem: string | null;
    sha256?: string;
    size?: number;
    mime?: string | null;
    tries?: number;
    retryAt?: Date;
  }) =>
    allScope(pool, (c) =>
      c.query(
        `UPDATE instagram_media SET status = $2, problem = $3, sha256 = $4, size = coalesce($5, size),
                mime = coalesce($6, mime), tries = coalesce($7, tries), retry_at = $8
          WHERE id = $1 AND status = 'waiting'`,
        [
          id,
          f.status,
          f.problem,
          f.sha256 ?? null,
          f.size ?? null,
          f.mime ?? null,
          f.tries ?? null,
          f.retryAt ?? null,
        ],
      ),
    );
  const later = (problem: string) =>
    set({ status: "waiting", problem, retryAt: new Date(now.getTime() + RETRY_MS) });
  if (!d.files) return void (await later(WORDS.cant_save));
  const disk = await d.files.disk();
  if (disk && usedShare(disk) >= DISK_STOP) return void (await later(WORDS.disk_full));
  // Today's files from this person, and from everyone on this account, are bounded: past either, nothing is fetched.
  const keys = { person: `media:${row.thread_id}`, account: `media:${row.account_id}` };
  const limits = { personBytes: row.person_mb * MB, accountBytes: row.account_mb * MB };
  const overLimit = async () => {
    await set({ status: "over_limit", problem: WORDS.over_limit });
    // The admins hear once a day, the first time the limit turns a file away.
    if (await firstRefusal(pool, `media:${row.account_id}`, dayOf(now)))
      await tellAdmins(
        pool,
        "Instagram: today's files reached their limit",
        `Files sent to @${row.username} today reached the limit, so LUME isn't keeping new ones until tomorrow. They're still in Instagram.`,
      ).catch((err: unknown) =>
        o.app.log.error({ err }, "couldn't tell the admins about Instagram's file limit"),
      );
  };
  // A retry of a file already counted (its fetch failed after) isn't held to the limit again.
  if (!row.counted && (await allScope(pool, (c) => bytesSpent(c, keys, limits, now))))
    return void (await overLimit());

  let got: { bytes: Buffer; type: string | null };
  try {
    got = await downloadIg(row.url, graphUrl);
  } catch (e) {
    if (!(e instanceof IgFetch)) throw e;
    if (e.kind === "too_large") return void (await set({ status: "too_large", problem: WORDS.too_large }));
    if (e.kind === "gone") return void (await set({ status: "gone", problem: WORDS.gone }));
    if (e.kind === "untrusted") {
      o.app.log.warn({ media: id }, "instagram media link wasn't on Meta's hosts; not fetched");
      return void (await set({ status: "failed", problem: WORDS.untrusted }));
    }
    const tries = row.tries + 1;
    if (tries >= TRIES) return void (await set({ status: "failed", problem: WORDS.failed, tries }));
    await set({ status: "waiting", problem: null, tries });
    throw e; // the queue tries again later
  }
  const sha256 = sha256Of(got.bytes);
  // Counted against today's limits, and the file's row first, touched now (the hourly sweep spares a file touched
  // within the hour): both or neither.
  const room = await allScope(pool, async (c) => {
    // Counted once: the row says so in the same transaction as the count, so a retry after a failed save skips it.
    const fresh = await c.query("SELECT 1 FROM instagram_media WHERE id = $1 AND NOT counted FOR UPDATE", [
      id,
    ]);
    if (fresh.rowCount) {
      if (!(await spendBytes(c, keys, limits, got.bytes.length, now))) return false;
      await c.query("UPDATE instagram_media SET counted = true WHERE id = $1", [id]);
    }
    await c.query(
      `INSERT INTO whatsapp_files (sha256, size) VALUES ($1, $2) ON CONFLICT (sha256) DO UPDATE SET last_ref_at = now()`,
      [sha256, got.bytes.length],
    );
    await c.query("DELETE FROM whatsapp_files_gone WHERE sha256 = $1", [sha256]);
    return true;
  });
  if (!room) return void (await overLimit());
  try {
    await d.files.store.put(got.bytes);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOSPC" || code === "EDQUOT") return void (await later(WORDS.disk_full));
    if (["EROFS", "EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(code))
      return void (await later(WORDS.cant_save));
    throw e;
  }
  const mime = got.type?.split(";")[0]?.trim().toLowerCase() || null;
  await set({ status: "ready", problem: null, sha256, size: got.bytes.length, mime });
}
