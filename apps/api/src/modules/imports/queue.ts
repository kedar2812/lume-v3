import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type pg from "pg";
import type { Keyring } from "@lume/core";
import { runImport } from "./runner";

/**
 * pg-boss inside the API, as lume_app (spec amendment 1): the worker role may not touch lead tables.
 * The worker's own pg-boss does the queue housekeeping, so this one only sends and works. One run per
 * import at a time (singletonKey); a thrown run is retried by the queue (retryLimit 5, with backoff).
 */
export async function startImportQueue(o: {
  connectionString: string;
  app: FastifyInstance;
  pool: pg.Pool;
  keyring: Keyring;
}) {
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema: "pgboss",
    migrate: false,
    supervise: false,
    schedule: false,
  });
  boss.on("error", (err) => o.app.log.error({ err }, "import queue error"));
  await boss.start();
  await boss.work<{ id: string }>("imports.run", { batchSize: 1 }, async ([job]) => {
    if (job) await runImport({ app: o.app, pool: o.pool, keyring: o.keyring }, job.data.id);
  });
  const enqueue = async (id: string) => {
    await boss.send("imports.run", { id }, { singletonKey: id });
  };
  // After a restart, anything queued or mid-run carries on (a row already finished is never redone).
  const { rows } = await o.pool.query<{ id: string }>(
    "SELECT id FROM imports WHERE status IN ('queued', 'running', 'cancelling')",
  );
  for (const r of rows) await enqueue(r.id);
  return { enqueue, stop: () => boss.stop({ graceful: true, wait: true, timeout: 20_000 }) };
}
