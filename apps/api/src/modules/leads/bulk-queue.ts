import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type pg from "pg";
import type { AppDeps } from "../../app";
import { processRun } from "./bulk-engine";

/**
 * Phase 7B: queued bulk runs, on pg-boss inside the API as imports are (the worker role may not touch leads).
 * One job per run (singletonKey), one run at a time in this instance; a thrown chunk is retried by the queue,
 * and a run picks up from its last committed chunk.
 */
export async function startBulkQueue(o: {
  connectionString: string;
  app: FastifyInstance;
  pool: pg.Pool;
  /** The follow-up queue, filled once it runs: a stage's rules schedule reminders through it. */
  tasks?: AppDeps["tasks"];
}) {
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema: "pgboss",
    migrate: false,
    supervise: false,
    schedule: false,
  });
  boss.on("error", (err) => o.app.log.error({ err }, "bulk queue error"));
  await boss.start();
  await boss.work<{ id: string }>("bulk.run", { batchSize: 1 }, async ([job]) => {
    if (job) await processRun({ app: o.app, pool: o.pool, tasks: o.tasks }, job.data.id);
  });
  const enqueue = async (id: string) => {
    // A long run may take a while on a small server: the queue mustn't give up on it and start a second beside it
    // (7B final review, Important 1; the run's own lock keeps a second one waiting either way).
    await boss.send(
      "bulk.run",
      { id },
      { singletonKey: id, retryLimit: 5, retryBackoff: true, expireInSeconds: 4 * 3600 },
    );
  };
  // After a restart, anything queued or mid-run carries on.
  const { rows } = await o.pool.query<{ id: string }>(
    "SELECT id FROM bulk_runs WHERE status IN ('queued', 'running') ORDER BY created_at",
  );
  for (const r of rows) await enqueue(r.id);
  return { enqueue, stop: () => boss.stop({ graceful: true, wait: true, timeout: 20_000 }) };
}
