import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type pg from "pg";
import type { Keyring } from "@lume/core";
import { heldBack } from "../../licence/enforce";
import type { GoogleCalendar } from "./google";
import { dueConnections, runCalendarSync } from "./sync";

/** An ask stands this long: a connection still due after it (the sync never ran) is asked for again. */
const ASK_STANDS_MS = 5 * 60_000;
const SYNC_WORKERS = 2;

/**
 * Once a minute: each active connection that's due is asked to sync, once — not again every minute while
 * that ask waits in the queue. Nothing while the licence holds scheduled work back (L-A).
 */
export function calendarTick(o: {
  pool: pg.Pool;
  enqueue: (id: string) => Promise<void>;
  held: () => boolean;
  now?: () => Date;
}): () => Promise<number> {
  const now = o.now ?? (() => new Date());
  const asked = new Map<string, number>();
  let ticking = false;
  return async () => {
    if (ticking || o.held()) return 0;
    ticking = true;
    try {
      const t = now().getTime();
      for (const [id, at] of asked) if (t - at >= ASK_STANDS_MS) asked.delete(id);
      let started = 0;
      for (const id of await dueConnections(o.pool, now())) {
        if (asked.has(id)) continue;
        asked.set(id, t);
        await o.enqueue(id);
        started++;
      }
      return started;
    } finally {
      ticking = false;
    }
  };
}

/** Calendar syncs run in the API process, as lume_app (as sheets do, spec §2.3), two at once. */
export async function startCalendarQueue(o: {
  connectionString: string;
  app: FastifyInstance;
  pool: pg.Pool;
  keyring: Keyring;
  clientFor: (grant: string) => GoogleCalendar | null;
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
  boss.on("error", (err) => o.app.log.error({ err }, "calendar queue error"));
  await boss.start();
  const deps = { pool: o.pool, keyring: o.keyring, clientFor: o.clientFor, log: o.app.log };
  // pg-boss 10 runs one job per worker.
  for (let i = 0; i < SYNC_WORKERS; i++)
    await boss.work<{ id: string }>(
      "calendar.sync",
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        if (job) await runCalendarSync(deps, job.data.id);
      },
    );
  // A failed sync is not retried by the queue: the sync records it and when to try again.
  const enqueue = async (id: string) => {
    await boss.send("calendar.sync", { id }, { retryLimit: 0 });
  };
  const tick = calendarTick({
    pool: o.pool,
    enqueue,
    held: () => heldBack(o.app, "scheduled calendar syncs"),
  });
  const run = () => void tick().catch((err: unknown) => o.app.log.error({ err }, "calendar tick failed"));
  const timer = setInterval(run, o.tickMs ?? 60_000);
  timer.unref();
  run();
  return {
    enqueue,
    stop: async () => {
      clearInterval(timer);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
