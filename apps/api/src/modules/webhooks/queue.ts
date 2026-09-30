import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type pg from "pg";
import type { Keyring } from "@lume/core";
import { processEvent } from "./process";

const SWEEP_MS = 60_000;
const NOT_PROCESSED = [
  {
    column: null,
    code: "NOT_PROCESSED",
    message: "LUME couldn't make this post into a lead in a day of trying. Retry it, or dismiss it.",
  },
];

/**
 * Nothing waits for ever (2C final review, Important 6). A post queued for over 2 minutes on a live webhook
 * lost its job (a restart, a failed send, or the queue giving up): it's queued again. One queued for a
 * day is a problem the page shows, with Retry. A paused webhook's posts wait for Resume.
 */
export async function sweepStale(pool: pg.Pool): Promise<number[]> {
  // Signatures past their five minutes can't be replayed any more (receive.ts): forgotten after ten.
  await pool.query("DELETE FROM webhook_signatures WHERE seen_at < now() - interval '10 minutes'");
  await pool.query(
    `UPDATE webhook_events e SET status = 'error', problems = $1::jsonb, processed_at = now()
      FROM lead_sources s
     WHERE s.id = e.source_id AND e.status = 'queued' AND s.status IN ('active', 'needs_attention')
       AND e.received_at < now() - interval '24 hours'`,
    [JSON.stringify(NOT_PROCESSED)],
  );
  const { rows } = await pool.query<{ id: string }>(
    `SELECT e.id FROM webhook_events e JOIN lead_sources s ON s.id = e.source_id
      WHERE e.status = 'queued' AND s.status IN ('active', 'needs_attention')
        AND e.received_at < now() - interval '2 minutes'
      ORDER BY e.id LIMIT 500`,
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Webhook posts are made into leads in the API process, as lume_app (like sheets, 2B), one at a time.
 * A post whose processing throws (not a data problem: those are the post's own) is tried again, and the
 * sweep catches any the queue lost.
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
  // One job per post at a time: a sweep that finds a post already queued doesn't queue it twice.
  const enqueue = async (id: number) => {
    await boss.send(
      "webhooks.process",
      { id },
      { retryLimit: 5, retryBackoff: true, singletonKey: String(id) },
    );
  };
  const sweep = async () => {
    try {
      for (const id of await sweepStale(o.pool)) await enqueue(id);
    } catch (err) {
      o.app.log.error({ err }, "webhooks sweep failed");
    }
  };
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref();
  void sweep();
  return {
    enqueue,
    stop: async () => {
      clearInterval(timer);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
