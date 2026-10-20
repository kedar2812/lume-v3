import PgBoss from "pg-boss";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../app";
import { makePreview, sweepPreviews } from "./preview";

const SWEEP_MS = 15 * 60_000;

/**
 * Media's previews in the API process (plan 2026-10-20-media-tab, Task 4): one at a time, since the render service
 * does one at a time. A job the service couldn't take (down, busy, slow) throws, so pg-boss tries it again with
 * backoff (30 s, 1 min, 2 min); the preview's own count of tries decides when it's left failed. The sweep catches
 * files from before Media and any job the queue lost.
 */
export async function startMediaQueue(o: { connectionString: string; app: FastifyInstance; d: AppDeps }) {
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema: "pgboss",
    migrate: false,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on("error", (err) => o.app.log.error({ err }, "media queue error"));
  await boss.start();
  await boss.work<{ sha256: string }>(
    "media.preview",
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) return;
      const made = await makePreview(o.d, job.data.sha256);
      if (made === "retry") throw new Error("the render service couldn't take it yet; trying again later");
      if (made === "failed") o.app.log.warn({ file: job.data.sha256.slice(0, 12) }, "media preview failed");
    },
  );
  const enqueuePreview = async (sha256: string) => {
    await boss.send(
      "media.preview",
      { sha256 },
      { retryLimit: 3, retryDelay: 30, retryBackoff: true, singletonKey: sha256 },
    );
  };
  const sweep = () =>
    sweepPreviews(o.d).catch((err: unknown) => o.app.log.error({ err }, "media preview sweep failed"));
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref();
  return { enqueuePreview, sweep, stop: () => (clearInterval(timer), boss.stop()) };
}
