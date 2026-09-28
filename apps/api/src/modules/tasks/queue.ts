import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type pg from "pg";
import { fire, sweep } from "./engine";
import { escalate } from "./escalation";
import { runDigests } from "./digest";
import { noTouch } from "./no-touch";
import { opsAlerts } from "../health/service";
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
  /** How often the clock ticks (LUME_FOLLOW_UP_TICK_MS); a minute unless tests ask for faster. */
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
  /** One job per reminder, at its time; the same reminder queued twice runs once. */
  const enqueue = async (reminders: { id: number; fireAt: Date }[]) => {
    for (const r of reminders)
      await boss.send(
        "tasks.fire",
        { id: r.id },
        { startAfter: r.fireAt, singletonKey: String(r.id), retryLimit: 5, retryBackoff: true },
      );
  };
  let lastSweepAt: Date | null = null;
  const sweepNow = async () => {
    try {
      const fired = await sweep(deps);
      lastSweepAt = new Date();
      if (fired) o.app.log.warn({ fired }, "the sweeper fired follow-up reminders the queue had missed");
    } catch (err) {
      o.app.log.error({ err }, "follow-up sweep failed");
    }
  };
  // Reminders come first and never wait on mail: escalation and the digest run beside the clock, one run of
  // each at a time, so a slow mail server can neither hold up a sweep nor start a second digest run
  // (3B final review, Important 1).
  const busy = { escalate: false, digest: false, noTouch: false, alerts: false };
  const beside = (key: keyof typeof busy, job: () => Promise<unknown>, what: string) => {
    if (busy[key]) return;
    busy[key] = true;
    void job()
      .catch((err: unknown) => o.app.log.error({ err }, what))
      .finally(() => (busy[key] = false));
  };
  let ticks = 0;
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    const n = ticks++;
    try {
      await sweepNow();
      // Every fifth minute: follow-ups left overdue reach their managers (3B).
      if (n % 5 === 0) beside("escalate", () => escalate(deps), "follow-up escalation failed");
      // Every quarter hour: whoever's morning it is gets their digest (3B).
      if (o.digest && n % 15 === 0)
        beside(
          "digest",
          () => runDigests({ pool: o.pool, ...o.digest!, log: o.app.log }),
          "daily digests failed",
        );
      // Every quarter hour: anything wrong reaches the admins, once a business day (3C System health).
      if (n % 15 === 0)
        beside(
          "alerts",
          () =>
            opsAlerts({
              app: o.app,
              pool: o.pool,
              lastSweepAt: () => lastSweepAt,
              ...(o.digest ? { mailer: o.digest.mailer, publicUrl: o.digest.publicUrl } : {}),
            }),
          "system alerts failed",
        );
      // Every hour (and at start-up): leads gone quiet come back to their owners (3C).
      if (n % 60 === 0) beside("noTouch", () => noTouch({ ...deps, enqueue }), "leads gone quiet failed");
    } finally {
      ticking = false;
    }
  };
  await tick(); // anything missed while LUME was down fires before it takes requests; mail goes on beside
  const timer = setInterval(() => void tick(), o.tickMs ?? SWEEP_MS);
  timer.unref();
  return {
    enqueue,
    lastSweepAt: () => lastSweepAt,
    stop: async () => {
      clearInterval(timer);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
