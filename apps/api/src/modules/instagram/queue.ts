import PgBoss from "pg-boss";
import type pg from "pg";
import { runDueFlows, sendPublicReply } from "./flow-due";
import { sweepInstagram } from "./inbox";
import { takeRelayNotes } from "./notes";
import { fetchInstagramMedia } from "./media";
import { ECHO_WAIT_MS, runInstagramEvent, type InstagramJobDeps } from "./process";
import { readInstagramProfile } from "./profile";
import {
  IG_SEND_RETRY_DELAY_S,
  IG_SEND_TRIES,
  IG_SENDING_STUCK_MS,
  igPacer,
  sendInstagramOutbox,
} from "./sender";
import { igGraphOf } from "./service";
import { sweepInstagramTokens } from "./token-refresh";

const SWEEP_MS = 60_000;
const PROCESS_WORKERS = 4;
const MEDIA_WORKERS = 2;
const PROFILE_WORKERS = 2;
const SEND_WORKERS = 8;

/**
 * Messages a lost job left behind: queued and untouched for 2 minutes, or "sending" for 10. Queued again; the sender
 * fails a "sending" one with words rather than sending it twice.
 */
export async function staleInstagramOutbox(pool: pg.Pool): Promise<string[]> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM instagram_outbox
        WHERE (status = 'queued' AND updated_at < now() - interval '2 minutes')
           OR (status = 'sending' AND updated_at < now() - make_interval(secs => $1))
        ORDER BY updated_at LIMIT 500`,
      [IG_SENDING_STUCK_MS / 1000],
    );
    await c.query("COMMIT");
    return rows.map((r) => r.id);
  } finally {
    c.release();
  }
}

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
    // Connections for fetching and finishing jobs only (the work itself runs on LUME's own pools, and each of these
    // is one short query). One keeps every queue together inside Postgres's 100: the others already hold 35 of the
    // 36 (packages/config connections.test).
    max: 1,
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
        if ((await runInstagramEvent(o, job.data.id)) === "later")
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
  // Replies (Task 6): eight senders, each message once (singleton), tried again with backoff when Meta is busy or the
  // account's pace is reached; one pace for the whole process.
  const limits = o.d.instagramLimits ?? { perSecond: 20, privateRepliesPerHour: 600 };
  const pacer = igPacer({ now: o.d.clock, perSecond: limits.perSecond });
  const enqueueSend = async (id: string) => {
    await boss.send(
      "instagram.send",
      { id },
      { retryLimit: IG_SEND_TRIES, retryDelay: IG_SEND_RETRY_DELAY_S, retryBackoff: true, singletonKey: id },
    );
  };
  for (let i = 0; i < SEND_WORKERS; i++)
    await boss.work<{ id: string }>(
      "instagram.send",
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        // A TryLater (Meta busy, the pace reached) throws through: pg-boss tries again after its delay.
        if (job)
          await sendInstagramOutbox(
            { ...o, pacer, privateRepliesPerHour: limits.privateRepliesPerHour },
            job.data.id,
          );
      },
    );
  // A flow's public reply under a comment: two workers, Meta's pace kept by the same pacer; a refusal is final.
  const enqueuePublic = async (commentId: string, text: string) => {
    await boss.send(
      "instagram.public",
      { commentId, text },
      { retryLimit: 3, retryDelay: 60, retryBackoff: true, singletonKey: commentId },
    );
  };
  for (let i = 0; i < 2; i++)
    await boss.work<{ commentId: string; text: string }>(
      "instagram.public",
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async ([job]) => {
        if (!job) return;
        await sendPublicReply({ ...o, pacer }, job.data.commentId, job.data.text);
      },
    );
  const pool = o.d.jobPool ?? o.d.pool;
  // Due flow steps: one sweep at a time (a slow one is never overlapped by the next minute's).
  let flowsBusy = false;
  const dueFlows = async () => {
    if (flowsBusy) return;
    flowsBusy = true;
    try {
      await runDueFlows(o);
    } catch (err) {
      o.app.log.error({ err }, "instagram flow sweep failed");
    } finally {
      flowsBusy = false;
    }
  };
  const sweep = async () => {
    void dueFlows();
    try {
      for (const id of await staleInstagramEvents(pool)) await enqueue(id);
      for (const id of await staleInstagramMedia(pool)) await enqueueMedia(id);
      for (const id of await staleInstagramOutbox(pool)) await enqueueSend(id);
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
    // What the relay kept for this LUME (gaps to catch up on, Meta's deauthorize and deletion requests).
    await takeRelayNotes({ ...o.d, log: o.app.log }).catch((err: unknown) =>
      o.app.log.error({ err }, "instagram relay notes failed"),
    );
  };
  const hourly = setInterval(() => void hourlyWork(), 3_600_000);
  hourly.unref();
  return {
    enqueue: (id: number) => enqueue(id),
    enqueueMedia,
    enqueueProfile,
    enqueueSend,
    enqueuePublic,
    stop: async () => {
      clearInterval(timer);
      clearInterval(hourly);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
