import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type pg from "pg";
import type { Keyring } from "@lume/core";
import { processEvent } from "./process";

/**
 * Webhook posts are made into leads in the API process, as lume_app (like sheets, 2B), one at a time.
 * A post whose processing throws (not a data problem: those are the post's own) is tried again.
 */
export async function startWebhookQueue(o: {
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
    max: 2,
  });
  boss.on("error", (err) => o.app.log.error({ err }, "webhooks queue error"));
  await boss.start();
  await boss.work<{ id: number }>(
    "webhooks.process",
    { batchSize: 1, pollingIntervalSeconds: 0.5 },
    async ([job]) => {
      if (job) await processEvent({ app: o.app, pool: o.pool, keyring: o.keyring }, job.data.id);
    },
  );
  return {
    enqueue: async (id: number) => {
      await boss.send("webhooks.process", { id }, { retryLimit: 5, retryBackoff: true });
    },
    stop: async () => {
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
