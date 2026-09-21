import PgBoss from "pg-boss";

/**
 * Install/upgrade pg-boss's schema and create our queues as lume_owner.
 * Queues are partitions of pgboss.job, which only the table owner may create,
 * so the worker (lume_worker) runs with migrate: false and never creates queues itself.
 */
export async function installQueueSchema(ownerUrl: string, queues: readonly string[]): Promise<void> {
  const boss = new PgBoss({
    connectionString: ownerUrl,
    schema: "pgboss",
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => undefined);
  await boss.start();
  try {
    for (const name of queues) {
      if (!(await boss.getQueue(name))) {
        await boss.createQueue(name, { name, retryLimit: 5, retryDelay: 60, retryBackoff: true });
      }
    }
  } finally {
    await boss.stop({ graceful: false, wait: true });
  }
}
