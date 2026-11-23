import type pg from "pg";
import { CLEAN_KINDS, newId, type CleanKind, type ClosedMonths } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError } from "../../http/errors";
import type { FileStore } from "../whatsapp/files";
import { sweepWhatsAppFiles } from "../whatsapp/keep";
import { forgetSurvey, measureParts, PARAMS_CTE, PARTS, partParams, type Part } from "./survey";

/**
 * Clean up (plan 2026-11-23-storage-clean-up, Task 2): what an admin ticked, cleared in the background. One at a time;
 * 1000 rows a transaction, so a team working never waits on it; the words of every message stay, each cleared file
 * saying so where it was. Then the files nothing points to any more leave the disk at once, not at the next hourly
 * sweep, and the clean-up's record says how much came back.
 */

/** Rows cleared in one transaction. */
export const CLEAN_BATCH = 1000;
/** What a cleared chat file says where it was. */
export const CLEARED_WORDS = {
  whatsapp_media: "LUME cleared this file to make room on the server. It's still on the phone.",
  instagram_media: "LUME cleared this file to make room on the server. It's still in Instagram.",
} as const;
/** How long before a clean-up began a file must have last been pointed at to go: a fetch in flight is newer. */
const IN_FLIGHT_MS = 10 * 60_000;
/** A running clean-up with no batch for this long is queued again (its job was lost: a restart, a queue fault). */
export const QUIET_MS = 15 * 60_000;
/** A clean-up still running after this long stops, with words: something keeps it from finishing. */
export const GIVE_UP_MS = 24 * 60 * 60_000;
/** Words for a clean-up that stopped, or finished with some room still to come. */
export const CLEANUP_WORDS = {
  failed: "LUME couldn't finish clearing. What it cleared is gone; the rest is as it was.",
  noStore: "LUME can't reach its files on this server, so nothing was cleared.",
  notQueued: "LUME couldn't start clearing. Nothing was cleared; try again.",
  gaveUp:
    "LUME stopped clearing after a day without finishing. What it cleared is gone; try again for the rest.",
  later: "The rest of the room comes back within the hour.",
} as const;

export type CleanupView = {
  id: string;
  kinds: CleanKind[];
  status: "running" | "done" | "failed";
  filesPlanned: number;
  bytesPlanned: number;
  filesDone: number;
  bytesDone: number;
  startedAt: string;
  finishedAt: string | null;
  /** Why it stopped, or what's still to come, in words; null when there's nothing to say. */
  problem: string | null;
};
type Row = {
  id: string;
  kinds: CleanKind[];
  closed_months: number | null;
  status: CleanupView["status"];
  files_planned: number;
  bytes_planned: string;
  files_done: number;
  bytes_done: string;
  started_at: Date;
  finished_at: Date | null;
  problem: string | null;
};
const view = (r: Row): CleanupView => ({
  id: r.id,
  kinds: r.kinds,
  status: r.status,
  filesPlanned: r.files_planned,
  bytesPlanned: Number(r.bytes_planned),
  filesDone: r.files_done,
  bytesDone: Number(r.bytes_done),
  startedAt: new Date(r.started_at).toISOString(),
  finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  problem: r.problem,
});

async function withAll<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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

/** A running clean-up stops as failed, with words (what it already cleared stays cleared). */
export async function stopCleanup(pool: pg.Pool, id: string, words: string): Promise<void> {
  await pool
    .query(
      "UPDATE storage_cleanups SET status = 'failed', finished_at = now(), problem = $2 WHERE id = $1 AND status = 'running'",
      [id, words],
    )
    .catch(() => undefined);
  forgetSurvey();
}

/**
 * The hourly look after clean-ups: one quiet for QUIET_MS is queued again (its job was lost), one running longer
 * than GIVE_UP_MS stops with words. Answers the ids queued again.
 */
export async function reviveCleanups(
  pool: pg.Pool,
  enqueue: (id: string) => Promise<void>,
): Promise<string[]> {
  await pool.query(
    `UPDATE storage_cleanups SET status = 'failed', finished_at = now(), problem = $1
      WHERE status = 'running' AND started_at < now() - make_interval(secs => $2)`,
    [CLEANUP_WORDS.gaveUp, GIVE_UP_MS / 1000],
  );
  const quiet = await pool.query<{ id: string }>(
    "SELECT id FROM storage_cleanups WHERE status = 'running' AND touched_at < now() - make_interval(secs => $1)",
    [QUIET_MS / 1000],
  );
  for (const { id } of quiet.rows) {
    await pool.query("UPDATE storage_cleanups SET touched_at = now() WHERE id = $1", [id]);
    await enqueue(id);
  }
  return quiet.rows.map((r) => r.id);
}

/** The clean-up running now, if any. */
export async function runningCleanup(pool: pg.Pool): Promise<CleanupView | null> {
  const r = await pool.query<Row>("SELECT * FROM storage_cleanups WHERE status = 'running' LIMIT 1");
  return r.rows[0] ? view(r.rows[0]) : null;
}

/** One clean-up, as its progress shows. */
export async function cleanupOf(pool: pg.Pool, id: string): Promise<CleanupView | null> {
  const r = await pool.query<Row>("SELECT * FROM storage_cleanups WHERE id = $1", [id]);
  return r.rows[0] ? view(r.rows[0]) : null;
}

/**
 * Starts a clean-up of these kinds: measured first (the files it will clear and the bytes that come back, every
 * kind together, so a file in two ticked kinds counts once), recorded, audited, queued. A clean-up already running
 * answers 409 with that one, to watch instead.
 */
export async function startCleanup(
  req: FastifyRequest,
  d: AppDeps,
  body: { kinds: CleanKind[]; closedMonths: ClosedMonths },
): Promise<CleanupView> {
  const pool = d.jobPool ?? d.pool;
  const kinds = CLEAN_KINDS.filter((k) => body.kinds.includes(k));
  const plan = await withAll(pool, (c) =>
    measureParts(
      c,
      kinds.flatMap((k) => PARTS[k]),
      partParams(body.closedMonths),
    ),
  );
  const id = newId();
  try {
    // In the request's own transaction, with its audit: a request that fails leaves no clean-up "running" behind.
    // Started on the database's clock: the files' "last pointed at" times are on it too.
    await req.db.execute(sql`
      INSERT INTO storage_cleanups (id, kinds, closed_months, status, files_planned, bytes_planned, started_by)
      VALUES (${id}, ${`{${kinds.join(",")}}`}::text[], ${body.closedMonths}, 'running', ${plan.files}, ${plan.bytes},
              ${req.actor!.userId})`);
  } catch (e) {
    // One at a time, whoever asks and however close together: the unique index on a running clean-up lets one in.
    // Postgres's code, on the error or (through the request's database) on its cause.
    const pg = e as { code?: string; cause?: { code?: string } };
    if ((pg.code ?? pg.cause?.code) === "23505") {
      const other = await runningCleanup(pool);
      throw new HttpError(
        409,
        "CLEANUP_RUNNING",
        "LUME is already clearing room. Here's how far it is.",
        other,
      );
    }
    throw e;
  }
  await audit(req, {
    action: "storage.cleaned",
    entityType: "storage_cleanup",
    entityId: id,
    diff: { kinds, closedMonths: body.closedMonths, files: plan.files, bytes: plan.bytes },
  });
  // Queued once the clean-up is on record; a queue that refuses it stops it with words (never left "running").
  req.afterCommit(
    () =>
      void (d.storage ? d.storage.enqueueCleanup(id) : Promise.reject(new Error("no storage queue"))).catch(
        () => stopCleanup(pool, id, CLEANUP_WORDS.notQueued),
      ),
  );
  // Read in the request's own transaction: it isn't committed yet.
  const row = (await req.db.execute<Row>(sql`SELECT * FROM storage_cleanups WHERE id = ${id}`)).rows[0]!;
  return view(row);
}

/** Clears one batch of a part; answers how many rows it cleared. */
export async function clearBatch(c: pg.PoolClient, p: Part, params: unknown[]): Promise<number> {
  // Only LUME's own constants are joined into the statement (PARTS' tables, columns and conditions, the batch size);
  // every value goes in as a parameter.
  const pick = `SELECT x.${p.id} FROM ${p.table} x WHERE ${p.where} LIMIT ${CLEAN_BATCH}`;
  if (p.table === "whatsapp_media" || p.table === "instagram_media") {
    const clear = `WITH ${PARAMS_CTE} UPDATE ${p.table} SET status = 'removed', sha256 = NULL, problem = $4 WHERE id IN (${pick})`;
    return (await c.query(clear, [...params, CLEARED_WORDS[p.table]])).rowCount ?? 0;
  }
  if (p.table === "file_previews") {
    const clear = `WITH ${PARAMS_CTE} UPDATE file_previews SET state = 'cleared', thumb_sha256 = NULL, pdf_sha256 = NULL WHERE sha256 IN (${pick})`;
    return (await c.query(clear, params)).rowCount ?? 0;
  }
  const clear = `WITH ${PARAMS_CTE} DELETE FROM message_files WHERE id IN (${pick})`;
  return (await c.query(clear, params)).rowCount ?? 0;
}

/**
 * The job: each ticked kind in batches until none is left, its count moving as each batch commits; then the files
 * nothing points to leave the disk, and the record says how many bytes came back. A clean-up that fails says so;
 * what it already cleared stays cleared (each batch is whole on its own).
 */
export async function runCleanup(
  o: {
    pool: pg.Pool;
    store: FileStore;
    log: { warn(o: object, m: string): void; error(o: object, m: string): void };
    now?: () => Date;
  },
  id: string,
): Promise<void> {
  const r = await o.pool.query<Row>("SELECT * FROM storage_cleanups WHERE id = $1 AND status = 'running'", [
    id,
  ]);
  const row = r.rows[0];
  if (!row) return;
  const now = o.now ? o.now() : new Date();
  const params = partParams(row.closed_months ?? 6);
  try {
    for (const kind of row.kinds)
      for (const part of PARTS[kind]) {
        for (;;) {
          const n = await withAll(o.pool, async (c) => {
            const cleared = await clearBatch(c, part, params);
            if (cleared)
              await c.query(
                `UPDATE storage_cleanups SET files_done = least(files_planned, files_done + $2), touched_at = now(),
                        bytes_done = CASE WHEN files_planned = 0 THEN 0
                                          ELSE bytes_planned * least(files_planned, files_done + $2) / files_planned END
                  WHERE id = $1`,
                [id, cleared],
              );
            return cleared;
          });
          if (n < CLEAN_BATCH) break;
        }
      }
    // The space comes back now: files nothing points to, last pointed at well before this began.
    const before = new Date(new Date(row.started_at).getTime() - IN_FLIGHT_MS);
    const freeable = await o.pool.query<{ n: string }>(
      "SELECT coalesce(sum(size), 0) AS n FROM whatsapp_files WHERE refs = 0 AND last_ref_at < $1",
      [before],
    );
    await o.pool.query("UPDATE storage_cleanups SET touched_at = now() WHERE id = $1", [id]);
    for (let tries = 0; tries < 10; tries++) {
      const swept = await sweepWhatsAppFiles({
        pool: o.pool,
        store: o.store,
        log: o.log,
        now,
        touchedBefore: before,
      });
      if (swept) break;
      await o.pool.query("UPDATE storage_cleanups SET touched_at = now() WHERE id = $1", [id]);
      await new Promise((res) => setTimeout(res, 3000)); // the hourly sweep has the lock: it frees them too
    }
    // What actually came back: what could go, less what's still waiting (the hourly sweep had the lock, or its time
    // ran out). Never more than is true when it's shown; the rest goes within the hour.
    const left = await o.pool.query<{ n: string }>(
      "SELECT coalesce(sum(size), 0) AS n FROM whatsapp_files WHERE refs = 0 AND last_ref_at < $1",
      [before],
    );
    const waiting = Number(left.rows[0]!.n);
    const back = Math.max(0, Number(freeable.rows[0]!.n) - waiting);
    await o.pool.query(
      `UPDATE storage_cleanups SET status = 'done', finished_at = now(), files_done = files_planned,
              bytes_done = $2::bigint, problem = $3 WHERE id = $1 AND status = 'running'`,
      [id, back, waiting > 0 ? CLEANUP_WORDS.later : null],
    );
  } catch (e) {
    o.log.error({ err: e, cleanup: id }, "storage clean-up failed");
    await stopCleanup(o.pool, id, CLEANUP_WORDS.failed);
  } finally {
    forgetSurvey();
  }
}
