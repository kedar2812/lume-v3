import { rm } from "node:fs/promises";
import type pg from "pg";
import { z } from "zod";
import type { AppDeps } from "../../app";
import type { FileStore } from "./files";

/** "Keep WhatsApp files for" (2026-10-19): forever (null, the default) or one of these. */
export const KEEP_MONTHS = z.union([z.literal(3), z.literal(6), z.literal(12), z.literal(24)]).nullable();
export type KeepMonths = z.infer<typeof KEEP_MONTHS>;
export const removedWords = (months: number) =>
  `LUME keeps WhatsApp files for ${months} months. This one is still on the phone.`;

/** A file nothing has pointed at for this long goes: a fetch in flight touches its file first, so it's never one. */
const UNUSED_MS = 3_600_000;
/** Rows or files in one transaction of the sweep. */
const BATCH = 1000;
/** How long one hourly sweep may run; the next hour takes the rest. */
const SWEEP_BUDGET_MS = 5 * 60_000;
type Log = { warn(o: object, msg: string): void; error(o: object, msg: string): void };

async function keepMonthsOf(c: Pick<pg.PoolClient, "query">): Promise<number | null> {
  const { rows } = await c.query<{ m: unknown }>(
    "SELECT integrations -> 'whatsapp' -> 'keepFilesMonths' AS m FROM settings WHERE id = 1",
  );
  const m = KEEP_MONTHS.safeParse(rows[0]?.m ?? null);
  return m.success ? m.data : null;
}

/**
 * Hourly (2026-10-19): files past the client's "keep for" are let go (the message stays, with words), then files
 * nothing points to any more go from the disk and onto the off-site list of files that went.
 *
 * - Only one API sweeps at a time (a session advisory lock; a second one skips).
 * - It works in batches, each its own short transaction, until done or its 5 minutes are up: a team of a thousand
 *   never has one transaction holding a million rows. The next hour goes on.
 * - What points at a file is whatsapp_files.refs, kept by a trigger: never a count under row-level security.
 * - A file is deleted with its row locked, inside the transaction: a fetch of the same bytes waits on that row, then
 *   writes the file again, so it can never end up pointing at a file that was just unlinked.
 * - If a count was wrong (media still point at the file), the FK refuses and the count is mended, not the sweep.
 */
export async function sweepWhatsAppFiles(o: {
  pool: pg.Pool;
  store: FileStore;
  log: Log;
  now?: Date;
  budgetMs?: number;
}): Promise<{ removed: number; deleted: number; mended: number } | null> {
  const now = o.now ?? new Date();
  const started = Date.now();
  const inTime = () => Date.now() - started < (o.budgetMs ?? SWEEP_BUDGET_MS);
  const c = await o.pool.connect();
  const tx = async <T>(fn: () => Promise<T>): Promise<T> => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
      const out = await fn();
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
  };
  try {
    const lock = await c.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('lume.whatsapp_files')) AS ok",
    );
    if (!lock.rows[0]?.ok) return null;
    try {
      let removed = 0;
      const months = await keepMonthsOf(c);
      while (months && inTime()) {
        const n = await tx(
          async () =>
            (
              await c.query(
                `UPDATE whatsapp_media SET status = 'removed', sha256 = NULL, problem = $3
                  WHERE id IN (SELECT id FROM whatsapp_media
                                WHERE status = 'ready' AND created_at < $1::timestamptz - make_interval(months => $2)
                                LIMIT $4)`,
                [now, months, removedWords(months), BATCH],
              )
            ).rowCount ?? 0,
        );
        removed += n;
        if (n < BATCH) break;
      }
      let deleted = 0;
      let mended = 0;
      while (inTime()) {
        const r = await tx(() => deleteUnused(c, o, now));
        deleted += r.deleted;
        mended += r.mended;
        if (r.seen < BATCH) break;
      }
      return { removed, deleted, mended };
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtext('lume.whatsapp_files'))").catch(() => undefined);
    }
  } finally {
    c.release();
  }
}

/** One batch of files nothing points to: deleted (the row, then the file, the row still locked) and listed as gone. */
async function deleteUnused(
  c: pg.PoolClient,
  o: { store: FileStore; log: Log },
  now: Date,
): Promise<{ seen: number; deleted: number; mended: number }> {
  const { rows: unused } = await c.query<{ sha256: string }>(
    `SELECT sha256 FROM whatsapp_files
      WHERE refs = 0 AND last_ref_at < $1::timestamptz - make_interval(secs => $2)
      ORDER BY last_ref_at LIMIT $3 FOR UPDATE SKIP LOCKED`,
    [now, UNUSED_MS / 1000, BATCH],
  );
  let deleted = 0;
  let mended = 0;
  for (const { sha256 } of unused) {
    await c.query("SAVEPOINT file");
    try {
      const del = await c.query(
        `DELETE FROM whatsapp_files WHERE sha256 = $1 AND refs = 0
            AND last_ref_at < $2::timestamptz - make_interval(secs => $3)`,
        [sha256, now, UNUSED_MS / 1000],
      );
      if (!del.rowCount) {
        await c.query("RELEASE SAVEPOINT file");
        continue;
      }
      await c.query(
        `INSERT INTO whatsapp_files_gone (sha256, gone_at) VALUES ($1, $2)
         ON CONFLICT (sha256) DO UPDATE SET gone_at = excluded.gone_at`,
        [sha256, now],
      );
      await o.store.remove(sha256);
      await c.query("RELEASE SAVEPOINT file");
      deleted++;
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT file");
      if ((e as { code?: string }).code === "23503") {
        // Media still point here: the count drifted. Mend it; the trigger keeps it right from now on.
        await c.query(
          "UPDATE whatsapp_files SET refs = greatest(refs, 1), last_ref_at = $2 WHERE sha256 = $1",
          [sha256, now],
        );
        mended++;
        o.log.warn({ file: sha256.slice(0, 12) }, "whatsapp file count mended");
      } else o.log.error({ err: e, file: sha256.slice(0, 12) }, "whatsapp file not removed");
    }
  }
  return { seen: unused.length, deleted, mended };
}

/**
 * Daily (2026-10-19): the disk against the database, one of the 256 folders at a time, never every hash in memory.
 * Files on disk with no row (an unlink that failed, a crash) and temp files a crash left go once they're an hour old;
 * a write in flight is always younger. Rows whose file is missing are counted for the log; the thread says so itself.
 */
export async function scanWhatsAppFiles(o: {
  pool: pg.Pool;
  store: FileStore;
  log: Log;
  now?: Date;
}): Promise<{ strays: number; temps: number; missing: number }> {
  const now = (o.now ?? new Date()).getTime();
  let strays = 0;
  let temps = 0;
  let missing = 0;
  for (let i = 0; i < 256; i++) {
    const prefix = i.toString(16).padStart(2, "0");
    // The disk first, then the database: a file written after the listing can't be taken for a stray.
    const disk = await o.store.scan(prefix);
    const { rows } = await o.pool.query<{ sha256: string }>(
      "SELECT sha256 FROM whatsapp_files WHERE sha256 >= $1 AND sha256 < $2",
      [prefix, `${prefix}g`],
    );
    const known = new Set(rows.map((r) => r.sha256));
    for (const f of disk.files)
      if (!known.has(f.sha256) && now - f.mtimeMs > UNUSED_MS)
        await o.store.remove(f.sha256).then(
          () => strays++,
          (err: unknown) =>
            o.log.error({ err, file: f.sha256.slice(0, 12) }, "stray whatsapp file not removed"),
        );
    for (const t of disk.temps)
      if (now - t.mtimeMs > UNUSED_MS) await rm(t.path, { force: true }).then(() => temps++);
    const onDisk = new Set(disk.files.map((f) => f.sha256));
    missing += rows.filter((r) => !onDisk.has(r.sha256)).length;
  }
  if (missing) o.log.warn({ missing }, "whatsapp files in the database but not on disk");
  return { strays, temps, missing };
}

/**
 * What a shorter "keep for" would remove, for the sheet that asks first: files older than that, and about how much
 * room it frees (files only those messages point at). Counts only, across every lead: it's a setting for everyone.
 */
export async function keepPreview(d: AppDeps, months: KeepMonths) {
  if (!months) return { files: 0, bytes: 0 };
  const pool = d.jobPool ?? d.pool;
  const c = await pool.connect();
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const { rows } = await c.query<{ files: string; bytes: string }>(
      `WITH old AS (
         SELECT sha256, count(*) AS n FROM whatsapp_media
          WHERE status = 'ready' AND created_at < $1::timestamptz - make_interval(months => $2)
          GROUP BY sha256
       )
       SELECT coalesce(sum(old.n), 0) AS files,
              coalesce(sum(f.size) FILTER (WHERE f.refs <= old.n), 0) AS bytes
         FROM old JOIN whatsapp_files f ON f.sha256 = old.sha256`,
      [d.clock(), months],
    );
    await c.query("COMMIT");
    return { files: Number(rows[0]?.files ?? 0), bytes: Number(rows[0]?.bytes ?? 0) };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
