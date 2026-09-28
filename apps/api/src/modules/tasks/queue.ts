import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type pg from "pg";
import { fire, sweep } from "./engine";
import { escalate } from "./escalation";
import { runDigests } from "./digest";
import type { Mailer } from "../../mail/mailer";

const SWEEP_MS = 60_000;

/**
 * Follow-up reminders fire in the API process, as lume_app (Phase 3 spec §3): a pg-boss job per reminder
 * at its time, and a sweeper every minute (and once before the API listens) for any the queue lost.
 */
export async function startTaskQueue(o: {
  connectionString: string;
  app: FastifyInstance;
  pool: pg.Pool;
  /** The daily digest (3B): how mail goes, and the address its links point at. */
  digest?: { mailer: Mailer; publicUrl: string };
}) {
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema: "pgboss",
    migrate: false,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on("error", (err) => o.app.log.error({ err }, "follow-up queue error"));
  await boss.start();
  const deps = { app: o.app, pool: o.pool };
  await boss.work<{ id: number }>(
    "tasks.fire",
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (job) await fire(deps, job.data.id);
    },
  );
  let lastSweepAt: Date | null = null;
  let ticks = 0;
  const tick = async () => {
    // Every fifth minute: follow-ups left overdue reach their managers (3B).
    if (ticks % 5 === 0)
      await escalate(deps).catch((err: unknown) => o.app.log.error({ err }, "follow-up escalation failed"));
    // Every quarter hour: whoever's morning it is gets their digest (3B).
    if (o.digest && ticks % 15 === 0)
      await runDigests({ pool: o.pool, ...o.digest }).catch((err: unknown) =>
        o.app.log.error({ err }, "daily digests failed"),
      );
    ticks++;
    try {
      const fired = await sweep(deps);
      lastSweepAt = new Date();
      if (fired) o.app.log.warn({ fired }, "the sweeper fired follow-up reminders the queue had missed");
    } catch (err) {
      o.app.log.error({ err }, "follow-up sweep failed");
    }
  };
  await tick(); // anything missed while LUME was down fires before it takes requests
  const timer = setInterval(() => void tick(), SWEEP_MS);
  timer.unref();
  return {
    /** One job per reminder, at its time; the same reminder queued twice runs once. */
    enqueue: async (reminders: { id: number; fireAt: Date }[]) => {
      for (const r of reminders)
        await boss.send(
          "tasks.fire",
          { id: r.id },
          { startAfter: r.fireAt, singletonKey: String(r.id), retryLimit: 5, retryBackoff: true },
        );
    },
    lastSweepAt: () => lastSweepAt,
    stop: async () => {
      clearInterval(timer);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
