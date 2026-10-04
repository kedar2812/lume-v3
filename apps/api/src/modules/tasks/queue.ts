import { heldBack } from "../../licence/enforce";
import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type pg from "pg";
import { fire, sweep } from "./engine";
import { escalate } from "./escalation";
import { runDigests } from "./digest";
import { noTouch } from "./no-touch";
import { askOutcomes } from "../meetings/outcomes";
import { opsAlerts } from "../health/service";
import { securitySweep } from "../security/sweep";
import { clearExpiredExports } from "../lead-exports/service";
import { rollupLeadCounts } from "../leads/query";
import { clearOldBulkItems } from "../leads/bulk-runs";
import { analyticsTick } from "../analytics/rollup";
import { runWeekly } from "../analytics/weekly";
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
  const startedAt = new Date();
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
  const busy = {
    escalate: false,
    digest: false,
    noTouch: false,
    alerts: false,
    outcomes: false,
    security: false,
    counts: false,
    analytics: false,
    weekly: false,
  };
  const beside = (key: keyof typeof busy, job: () => Promise<unknown>, what: string) => {
    if (busy[key]) return;
    busy[key] = true;
    void job()
      .catch((err: unknown) => o.app.log.error({ err }, what))
      .finally(() => (busy[key] = false));
  };
  const analyticsMemory: { lastNight?: string; lastWeek?: string } = {};
  let ticks = 0;
  let ticking = false;
  const tick = async () => {
    // Locked (L-A): the whole clock waits — reminders, escalation, the morning email, alerts, no-touch.
    if (ticking || heldBack(o.app, "the follow-up clock")) return;
    ticking = true;
    const n = ticks++;
    try {
      await sweepNow();
      // Every minute: the stage strip's counts fold in what changed (7A, 0048).
      beside("counts", () => rollupLeadCounts(o.pool), "rolling up lead counts failed");
      // Every fifth minute: follow-ups left overdue reach their managers (3B).
      if (n % 5 === 0) beside("escalate", () => escalate(deps), "follow-up escalation failed");
      // Every fifth minute: a meeting with a lead that has ended asks its owner how it went (5A).
      if (n % 5 === 0) beside("outcomes", () => askOutcomes({ ...deps, enqueue }), "Log outcome failed");
      // Every fifth minute: the watch's safety net — anyone past a security rule's line is caught (6A).
      if (n % 5 === 0)
        beside(
          "security",
          () => securitySweep({ pool: o.pool, clock: () => new Date() }),
          "the security sweep failed",
        );
      // Every quarter hour: whoever's morning it is gets their digest (3B).
      if (o.digest && n % 15 === 0)
        beside(
          "digest",
          () => runDigests({ pool: o.pool, ...o.digest!, log: o.app.log }),
          "daily digests failed",
        );
      // Every quarter hour: Monday's look at last week reaches those who see all analytics, once (8B).
      if (o.digest && n % 15 === 0)
        beside(
          "weekly",
          () => runWeekly({ pool: o.pool, ...o.digest!, log: o.app.log }),
          "weekly analytics emails failed",
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
              startedAt,
              ...(o.digest ? { mailer: o.digest.mailer, publicUrl: o.digest.publicUrl } : {}),
            }),
          "system alerts failed",
        );
      // Analytics' daily rollups (8A): today and yesterday every 10 minutes, the week nightly, 90 days weekly.
      beside(
        "analytics",
        () => analyticsTick(o.pool, new Date(), n, analyticsMemory),
        "analytics rollup failed",
      );
      // Every hour (and at start-up): lead export files older than 24 hours are removed (6B).
      if (n % 60 === 0)
        void clearExpiredExports(o.pool).catch((err: unknown) =>
          o.app.log.error({ err }, "clearing old exports failed"),
        );
      // Every hour (and at start-up): bulk runs' items older than 30 days are cleared; the runs stay (7B).
      if (n % 60 === 0)
        void clearOldBulkItems(o.pool).catch((err: unknown) =>
          o.app.log.error({ err }, "clearing old bulk run items failed"),
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
    startedAt,
    stop: async () => {
      clearInterval(timer);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
