import { heldBack } from "../../licence/enforce";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type pg from "pg";
import type { Keyring } from "@lume/core";
import { schema } from "@lume/db";
import type { SheetConfig } from "./config";
import type { GoogleSheets } from "./google";
import { requestSync, type TxLike } from "./requests";
import { runSync, type SyncDeps } from "./sync";

/** Active sheets whose next sync is due, while the Sheets module is switched on (spec §3, §5.1). */
export async function dueSources(db: TxLike): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT l.id FROM lead_sources l, settings s
    WHERE s.id = 1 AND COALESCE((s.integrations -> 'googleSheets' ->> 'enabled')::boolean, false)
      AND l.type = 'google_sheet' AND l.status = 'active'
      AND (l.next_sync_at IS NULL OR l.next_sync_at <= now())
    ORDER BY l.next_sync_at NULLS FIRST
    LIMIT 50`);
  return rows.map((r) => r.id);
}

/**
 * On start-up: a sync still queued or running was cut off by a restart (one API per instance runs every
 * sync). Close it and free its sheet, so nothing waits out a 15-minute lock for a sync that isn't coming.
 */
export async function recoverStaleSyncs(db: TxLike): Promise<number> {
  const { rows } = await db.execute<{ id: string }>(
    sql`UPDATE source_syncs SET status = 'failed', error = 'stopped', finished_at = now() WHERE status IN ('queued', 'running') RETURNING id`,
  );
  await db.execute(
    sql`UPDATE lead_sources SET current_sync_id = NULL, sync_lock_until = NULL WHERE current_sync_id IS NOT NULL`,
  );
  return rows.length;
}

const SYNC_WORKERS = 3;

/**
 * Sheet syncs run in the API process, as lume_app (like imports, 2A amendment 1), up to three at once. Once a
 * minute, due sources are asked to sync. A sync that died with its process is picked up again when its
 * lock runs out: the next request replaces it.
 */
export async function startSheetsQueue(o: {
  connectionString: string;
  app: FastifyInstance;
  pool: pg.Pool;
  keyring: Keyring;
  google: GoogleSheets | null;
  /** Clients for sheets connected with Google (2B-2), when that's configured here. */
  clientFor?: (cfg: SheetConfig) => GoogleSheets | null;
  maxRows: number;
  tickMs?: number;
  /** Follow-up reminders (a rule's follow-up for a synced lead is armed at once). */
  tasks?: SyncDeps["tasks"];
}) {
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema: "pgboss",
    migrate: false,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on("error", (err) => o.app.log.error({ err }, "sheets queue error"));
  await recoverStaleSyncs(drizzle(o.pool, { schema }));
  await boss.start();
  // Up to three sheets at once (each sheet still one sync at a time, by its own lock), so a big first
  // import never holds back every other sheet and Refresh. pg-boss 10 runs one job per worker.
  for (let i = 0; i < SYNC_WORKERS; i++)
    await boss.work<{ id: string }>(
      "sheets.sync",
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        if (job)
          await runSync(
            {
              app: o.app,
              pool: o.pool,
              keyring: o.keyring,
              google: o.google,
              ...(o.clientFor ? { clientFor: o.clientFor } : {}),
              maxRows: o.maxRows,
              ...(o.tasks ? { tasks: o.tasks } : {}),
            },
            job.data.id,
          );
      },
    );
  // A failed sync is not retried by the queue: the sync itself records the failure and when to try again.
  const enqueue = async (id: string) => {
    await boss.send("sheets.sync", { id }, { retryLimit: 0 });
  };
  const db = drizzle(o.pool, { schema });
  let ticking = false;
  const tick = async () => {
    // Locked (L-A): no scheduled syncs; one already queued finishes.
    if (ticking || heldBack(o.app, "scheduled sheet syncs")) return 0;
    ticking = true;
    let started = 0;
    try {
      for (const sourceId of await dueSources(db)) {
        const r = await db.transaction((tx) =>
          requestSync(tx, { sourceId, trigger: "schedule", requestedBy: null }),
        );
        if (r?.fresh) {
          await enqueue(r.syncId);
          started++;
        }
      }
    } catch (err) {
      o.app.log.error({ err }, "sheets tick failed");
    } finally {
      ticking = false;
    }
    return started;
  };
  const timer = setInterval(() => void tick(), o.tickMs ?? 60_000);
  timer.unref();
  void tick();
  return {
    enqueue,
    tick,
    stop: async () => {
      clearInterval(timer);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
