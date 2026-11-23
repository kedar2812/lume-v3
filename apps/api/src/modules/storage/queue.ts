import type PgBoss from "pg-boss";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../app";
import { CLEANUP_WORDS, reviveCleanups, runCleanup, stopCleanup } from "./clean";
import { suggestStorage } from "./suggest";

const CHECK_MS = 60 * 60_000;

/**
 * Storage's work in the API process (plan 2026-11-23-storage-clean-up): one clean-up at a time (a second one is
 * refused at the door), and the hourly look at the disk that tells the admins when it's filling.
 */
export async function startStorageQueue(o: { boss: PgBoss; app: FastifyInstance; d: AppDeps }) {
  // On the media queue's pg-boss (file work too): no connections of its own, so LUME stays inside Postgres's 100.
  const boss = o.boss;
  const pool = o.d.jobPool ?? o.d.pool;
  await boss.work<{ id: string }>(
    "storage.cleanup",
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) return;
      if (!o.d.files) return stopCleanup(pool, job.data.id, CLEANUP_WORDS.noStore);
      await runCleanup({ pool, store: o.d.files.store, log: o.app.log, now: o.d.clock }, job.data.id);
    },
  );
  const enqueueCleanup = async (id: string) => {
    // A big clean-up runs long: pg-boss's own 15 minutes would start it again while it still runs.
    await boss.send(
      "storage.cleanup",
      { id },
      { retryLimit: 3, retryDelay: 60, singletonKey: id, expireInSeconds: 6 * 60 * 60 },
    );
  };
  const check = async () => {
    await reviveCleanups(pool, enqueueCleanup).catch((err: unknown) =>
      o.app.log.error({ err }, "storage clean-up look-after failed"),
    );
    await suggestStorage(pool, o.d.files ?? undefined, o.d.clock()).catch((err: unknown) =>
      o.app.log.error({ err }, "storage check failed"),
    );
  };
  // At start too: a clean-up whose job died with the last process carries on.
  void check();
  const timer = setInterval(() => void check(), CHECK_MS);
  timer.unref();
  // The queue is the media queue's: it stops with it.
  return { enqueueCleanup, check, stop: () => clearInterval(timer) };
}
