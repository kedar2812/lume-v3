import PgBoss from "pg-boss";
import type { MaintenanceJobs } from "./maintenance";
import type { OpsJobs } from "./ops";

export type Logger = { info: (o: object, msg?: string) => void; error: (o: object, msg?: string) => void };

/** Start pg-boss as lume_worker (no schema rights: migrate: false) and wire the ops crons (report §12.7). */
export async function startQueue(opts: {
  connectionString: string;
  jobs: OpsJobs;
  maintenance: MaintenanceJobs;
  log: Logger;
}): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: opts.connectionString, schema: "pgboss", migrate: false });
  boss.on("error", (err) => opts.log.error({ err }, "queue error"));
  await boss.start();
  await boss.schedule("ops.backup", "0 */6 * * *", {}, { tz: "UTC" });
  await boss.schedule("ops.restore-test", "0 4 * * 1", {}, { tz: "UTC" });
  await boss.work("ops.backup", { batchSize: 1 }, async () => {
    const r = await opts.jobs.backup();
    opts.log.info({ backup: r.name, bytes: r.bytes, deleted: r.deleted.length }, "backup complete");
  });
  await boss.work("ops.restore-test", { batchSize: 1 }, async () => {
    await opts.jobs.restoreTest();
    opts.log.info({}, "restore test passed");
  });
  await boss.schedule("ops.idempotency-cleanup", "17 * * * *", {}, { tz: "UTC" });
  await boss.work("ops.idempotency-cleanup", { batchSize: 1 }, async () => {
    const purged = await opts.maintenance.purgeIdempotencyKeys();
    opts.log.info({ purged }, "idempotency keys purged");
  });
  return boss;
}
