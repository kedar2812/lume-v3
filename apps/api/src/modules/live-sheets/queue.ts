import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import PgBoss from "pg-boss";
import { newId } from "@lume/core";
import type { AppDeps } from "../../app";
import { runLiveSheet } from "./run";

/**
 * Live sheets (spec 2026-11-14 §6): when they run. On the same rhythm as lead fetching (each sheet's poll_seconds,
 * 120 by default, its back-off set by the run), at once on Refresh and on Update now; one run per sheet at a time
 * (the partial unique index), so triggers that land together join one run.
 */
export type RunTrigger = "make" | "schedule" | "refresh" | "now" | "edit";
export const LIVE_SHEETS_QUEUE = "live-sheets.run";

type Db = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

/** requestRun inside a request's own transaction (Refresh, Update now, a new or edited sheet). */
export async function requestRunIn(
  db: FastifyRequest["db"],
  o: { sheetId: string; trigger: RunTrigger; requestedBy: string | null },
): Promise<{ runId: string; fresh: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const made = await db.execute<{ id: string }>(sql`
      INSERT INTO live_sheet_runs (id, sheet_id, trigger, requested_by, status)
      VALUES (${newId()}, ${o.sheetId}, ${o.trigger}, ${o.requestedBy}, 'queued')
      ON CONFLICT (sheet_id) WHERE status IN ('queued', 'running') DO NOTHING RETURNING id`);
    if (made.rows[0]) return { runId: made.rows[0].id, fresh: true };
    const open = await db.execute<{ id: string }>(
      sql`SELECT id FROM live_sheet_runs WHERE sheet_id = ${o.sheetId} AND status IN ('queued', 'running') LIMIT 1`,
    );
    if (open.rows[0]) return { runId: open.rows[0].id, fresh: false };
  }
  throw new Error("live sheet run: couldn't settle on a run");
}

/** The sheet's queued or running run, or a new one. `fresh`: this call made it (and should queue it). */
export async function requestRun(
  db: Db,
  o: { sheetId: string; trigger: RunTrigger; requestedBy: string | null },
): Promise<{ runId: string; fresh: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const made = await db.query<{ id: string }>(
      `INSERT INTO live_sheet_runs (id, sheet_id, trigger, requested_by, status) VALUES ($1, $2, $3, $4, 'queued')
       ON CONFLICT (sheet_id) WHERE status IN ('queued', 'running') DO NOTHING RETURNING id`,
      [newId(), o.sheetId, o.trigger, o.requestedBy],
    );
    if (made.rows[0]) return { runId: made.rows[0].id, fresh: true };
    const open = await db.query<{ id: string }>(
      "SELECT id FROM live_sheet_runs WHERE sheet_id = $1 AND status IN ('queued', 'running') LIMIT 1",
      [o.sheetId],
    );
    // Between the two, that run may have finished: try again.
    if (open.rows[0]) return { runId: open.rows[0].id, fresh: false };
  }
  throw new Error("live sheet run: couldn't settle on a run");
}

/**
 * Sheets whose time has come. A paused one still runs when a privacy pass can (its maker, its plan, the licence or a
 * person paused it: Google still answers, so deleted leads still leave); one paused for Google can't, until fixed.
 */
export async function dueSheets(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM live_sheets
      WHERE deleted_at IS NULL AND next_sync_at <= now()
        AND (status <> 'paused' OR pause_reason IN ('maker_gone', 'tier', 'licence', 'paused_by_person'))
      ORDER BY next_sync_at LIMIT 200`,
  );
  return rows.map((r) => r.id);
}

/** At start-up: runs cut off by a restart are closed, so their sheets run again on the next tick. */
export async function recoverStaleRuns(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE live_sheet_runs SET status = 'failed', error = 'Cut off by a restart', finished_at = now()
      WHERE status IN ('queued', 'running')`,
  );
  await db.query("UPDATE live_sheets SET status = 'live' WHERE status = 'updating'");
  return rowCount ?? 0;
}

/** Due sheets asked to run; how many runs this started. */
export async function tickLiveSheets(o: {
  pool: Db;
  enqueue: (runId: string, sheetId: string) => Promise<void>;
}): Promise<number> {
  let started = 0;
  for (const sheetId of await dueSheets(o.pool)) {
    const r = await requestRun(o.pool, { sheetId, trigger: "schedule", requestedBy: null });
    if (!r.fresh) continue;
    await o.enqueue(r.runId, sheetId);
    started++;
  }
  return started;
}

const WORKERS = 2;

/** Live sheets run in the API process, as lume_app, two at once (each sheet one run at a time). */
export async function startLiveSheetsQueue(o: {
  connectionString: string;
  app: FastifyInstance;
  d: AppDeps;
  tickMs?: number;
}) {
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema: "pgboss",
    migrate: false,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on("error", (err) => o.app.log.error({ err }, "live sheets queue error"));
  const pool = o.d.jobPool ?? o.d.pool;
  await recoverStaleRuns(pool);
  await boss.start();
  for (let i = 0; i < WORKERS; i++)
    await boss.work<{ runId: string; sheetId: string }>(
      LIVE_SHEETS_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        if (job) await runLiveSheet({ app: o.app, d: o.d, sheetId: job.data.sheetId, runId: job.data.runId });
      },
    );
  // A run records its own failure and when to try again: the queue never retries it.
  const enqueue = async (runId: string, sheetId: string) => {
    await boss.send(LIVE_SHEETS_QUEUE, { runId, sheetId }, { retryLimit: 0 });
  };
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tickLiveSheets({ pool, enqueue });
    } catch (err) {
      o.app.log.error({ err }, "live sheets tick failed");
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), o.tickMs ?? 60_000);
  timer.unref();
  return {
    enqueue,
    async stop() {
      clearInterval(timer);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
