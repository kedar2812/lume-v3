import PgBoss from "pg-boss";
import type pg from "pg";
import { sweepInstagram } from "./inbox";
import { fetchInstagramMedia } from "./media";
import { ECHO_WAIT_MS, processInstagramEvent, type InstagramJobDeps } from "./process";
import { readInstagramProfile } from "./profile";
import { igGraphOf } from "./service";
import { sweepInstagramTokens } from "./token-refresh";

const SWEEP_MS = 60_000;
const PROCESS_WORKERS = 4;
const MEDIA_WORKERS = 2;
const PROFILE_WORKERS = 2;

/** Events that waited 2 minutes without a job (a restart, a lost job), for accounts that can take them now. */
export async function staleInstagramEvents(pool: pg.Pool): Promise<number[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT e.id FROM instagram_events e JOIN instagram_accounts a ON a.ig_user_id = e.account_ig_id
      WHERE e.status = 'queued' AND a.status = 'active' AND e.received_at < now() - interval '2 minutes'
      ORDER BY e.id LIMIT 500`,
  );
  return rows.map((r) => Number(r.id));
}

/** Files still waiting (a lost job, or one told to wait for the disk): fetched again, while Meta's links last. */
export async function staleInstagramMedia(pool: pg.Pool): Promise<string[]> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM instagram_media
        WHERE status = 'waiting' AND created_at < now() - interval '2 minutes' AND created_at > now() - interval '7 days'
          AND (retry_at IS NULL OR retry_at <= now())
        ORDER BY created_at LIMIT 200`,
    );
    await c.query("COMMIT");
    return rows.map((r) => r.id);
  } finally {
    c.release();
  }
}

/**
 * Instagram's work in the API process, as lume_app (NEW_FEATURES_PLAN §6): deliveries into conversations, files
 * fetched, profiles read, and (Task 6) replies sent. A job that throws is tried again; the minute sweep catches any
 * the queue lost; nothing is lost to a restart because every piece of work is a row first.
 */
export async function startInstagramQueue(o: InstagramJobDeps & { connectionString: string }) {
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema: "pgboss",
    migrate: false,
    supervise: false,
    schedule: false,
    max: 2 + PROCESS_WORKERS + MEDIA_WORKERS + PROFILE_WORKERS,
  });
  boss.on("error", (err) => o.app.log.error({ err }, "instagram queue error"));
  await boss.start();
  const enqueue = async (id: number, startAfterS?: number) => {
    await boss.send(
      "instagram.process",
      { id },
      {
        retryLimit: 5,
        retryBackoff: true,
        singletonKey: String(id),
        ...(startAfterS ? { startAfter: startAfterS } : {}),
      },
    );
  };
  for (let i = 0; i < PROCESS_WORKERS; i++)
    await boss.work<{ id: number }>(
      "instagram.process",
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        if (!job) return;
        // An echo of LUME's own send still in flight: looked at again shortly, when the send has its id.
        if ((await processInstagramEvent(o, job.data.id)) === "later")
          await enqueue(job.data.id, Math.ceil(ECHO_WAIT_MS / 1000));
      },
    );
  const enqueueMedia = async (id: string) => {
    await boss.send("instagram.media", { id }, { retryLimit: 3, retryDelay: 120, singletonKey: id });
  };
  for (let i = 0; i < MEDIA_WORKERS; i++)
    await boss.work<{ id: string }>(
      "instagram.media",
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async ([job]) => {
        if (job) await fetchInstagramMedia(o, job.data.id);
      },
    );
  const enqueueProfile = async (id: string) => {
    await boss.send(
      "instagram.profile",
      { id },
      { retryLimit: 5, retryDelay: 300, retryBackoff: true, singletonKey: id },
    );
  };
  for (let i = 0; i < PROFILE_WORKERS; i++)
    await boss.work<{ id: string }>(
      "instagram.profile",
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async ([job]) => {
        if (job && (await readInstagramProfile(o, job.data.id)) === "later")
          throw new Error("Instagram didn't answer; reading the profile again later");
      },
    );
  const pool = o.d.jobPool ?? o.d.pool;
  const sweep = async () => {
    try {
      for (const id of await staleInstagramEvents(pool)) await enqueue(id);
      for (const id of await staleInstagramMedia(pool)) await enqueueMedia(id);
    } catch (err) {
      o.app.log.error({ err }, "instagram sweep failed");
    }
  };
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref();
  void sweep();
  // Hourly: Not a lead yet keeps 14 days, processed deliveries 30; each account's token refreshed at 30 days.
  const hourlyWork = async () => {
    await sweepInstagram(pool).catch((err: unknown) =>
      o.app.log.error({ err }, "instagram retention failed"),
    );
    await sweepInstagramTokens(pool, { ...o.d, graph: igGraphOf(o.d) }).catch((err: unknown) =>
      o.app.log.error({ err }, "instagram token refresh failed"),
    );
  };
  const hourly = setInterval(() => void hourlyWork(), 3_600_000);
  hourly.unref();
  return {
    enqueue: (id: number) => enqueue(id),
    enqueueMedia,
    enqueueProfile,
    stop: async () => {
      clearInterval(timer);
      clearInterval(hourly);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
