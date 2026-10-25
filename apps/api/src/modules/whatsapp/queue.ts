import PgBoss from "pg-boss";
import type pg from "pg";
import { sweepWhatsApp } from "./inbox";
import { sweepNumberHealth } from "./health";
import { scanWhatsAppFiles, sweepWhatsAppFiles } from "./keep";
import { fetchMedia } from "./media";
import { processWhatsAppEvent, type WhatsAppJobDeps } from "./process";
import { readReplyMeaning } from "./meaning";
import { sendOutbox } from "./sender";
import { sweepTemplates } from "./submit";
import { relayOf } from "./service";
import { relayTokenRefresh, sweepWhatsAppTokens } from "./token-refresh";

const SWEEP_MS = 60_000;
const MEDIA_WORKERS = 4;
const SEND_WORKERS = 8;

/**
 * Messages that waited too long (2 minutes) without a job — a restart, a failed send — are queued again; ones for a
 * number that needs attention wait until it's connected again.
 */
export async function staleEvents(pool: pg.Pool): Promise<number[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT e.id FROM whatsapp_events e JOIN whatsapp_numbers n ON n.phone_number_id = e.phone_number_id
      WHERE e.status = 'queued' AND n.status = 'active' AND e.received_at < now() - interval '2 minutes'
      ORDER BY e.id LIMIT 500`,
  );
  return rows.map((r) => Number(r.id));
}

/**
 * WhatsApp's work in the API process, as lume_app (spec 2026-10-18 §4): one message at a time into lead activity, and
 * (Task 7) media fetched to this server. A job that throws is tried again; the sweep catches any the queue lost.
 */
/** Files still waiting while their number is connected (after a reconnect, or a lost job): fetched again. */
export async function staleMedia(pool: pg.Pool): Promise<string[]> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const { rows } = await c.query<{ id: string }>(
      `SELECT m.id FROM whatsapp_media m JOIN whatsapp_numbers n ON n.id = m.number_id
        WHERE m.status = 'waiting' AND n.status = 'active' AND m.created_at < now() - interval '2 minutes'
          AND m.created_at > now() - interval '30 days' AND (m.retry_at IS NULL OR m.retry_at <= now())
        ORDER BY m.created_at LIMIT 200`,
    );
    await c.query("COMMIT");
    return rows.map((r) => r.id);
  } finally {
    c.release();
  }
}

/**
 * Replies from LUME a lost job left behind (plan W3a): queued or sending, untouched for 2 minutes. Queued again;
 * the sender fails a "sending" one with words rather than sending it twice.
 */
export async function staleOutbox(pool: pg.Pool): Promise<string[]> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM whatsapp_outbox WHERE status IN ('queued', 'sending') AND updated_at < now() - interval '2 minutes'
        ORDER BY updated_at LIMIT 500`,
    );
    await c.query("COMMIT");
    return rows.map((r) => r.id);
  } finally {
    c.release();
  }
}

export async function startWhatsAppQueue(o: WhatsAppJobDeps & { connectionString: string }) {
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema: "pgboss",
    migrate: false,
    supervise: false,
    schedule: false,
    max: 4 + MEDIA_WORKERS + SEND_WORKERS,
  });
  boss.on("error", (err) => o.app.log.error({ err }, "whatsapp queue error"));
  await boss.start();
  await boss.work<{ id: number }>(
    "whatsapp.process",
    { batchSize: 1, pollingIntervalSeconds: 0.5 },
    async ([job]) => {
      if (job) await processWhatsAppEvent(o, job.data.id);
    },
  );
  // Four fetchers: a team of hundreds sends bursts of photos and brochures; each fetch is mostly waiting on Meta.
  for (let i = 0; i < MEDIA_WORKERS; i++)
    await boss.work<{ id: string }>(
      "whatsapp.media",
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async ([job]) => {
        if (job) await fetchMedia(o, job.data.id);
      },
    );
  const enqueue = async (id: number) => {
    await boss.send(
      "whatsapp.process",
      { id },
      { retryLimit: 5, retryBackoff: true, singletonKey: String(id) },
    );
  };
  const enqueueMedia = async (id: string) => {
    await boss.send("whatsapp.media", { id }, { retryLimit: 3, retryDelay: 120, singletonKey: id });
  };
  // Replies from LUME (plan W3a): eight senders, so a team of hundreds replying at once doesn't wait in line; each
  // message once (singleton), tried again with backoff when Meta is busy.
  for (let i = 0; i < SEND_WORKERS; i++)
    await boss.work<{ id: string }>(
      "whatsapp.send",
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        if (job) await sendOutbox(o, job.data.id);
      },
    );
  const enqueueSend = async (id: string) => {
    await boss.send("whatsapp.send", { id }, { retryLimit: 5, retryBackoff: true, singletonKey: id });
  };
  // What a reply means (W2): one read per reply, two at a time; the provider is the slow part.
  for (let i = 0; i < 2; i++)
    await boss.work<{ id: string }>(
      "whatsapp.meaning",
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async ([job]) => {
        if (job) await readReplyMeaning(o, job.data.id);
      },
    );
  const enqueueMeaning = async (id: string) => {
    await boss.send("whatsapp.meaning", { id }, { retryLimit: 2, retryDelay: 60, singletonKey: id });
  };
  const pool = o.d.jobPool ?? o.d.pool;
  const sweep = async () => {
    try {
      for (const id of await staleEvents(pool)) await enqueue(id);
      for (const id of await staleMedia(pool)) await enqueueMedia(id);
      for (const id of await staleOutbox(pool)) await enqueueSend(id);
    } catch (err) {
      o.app.log.error({ err }, "whatsapp sweep failed");
    }
  };
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref();
  void sweep();
  // Hourly: Not a lead yet keeps 14 days, processed events 30; then files past "keep for", and files nothing points
  // to any more (2026-10-19). Daily: the disk against the database (strays, temp files a crash left).
  let lastScan = 0;
  const files = o.d.files;
  const hourlyWork = async () => {
    await sweepWhatsApp(pool).catch((err: unknown) => o.app.log.error({ err }, "whatsapp retention failed"));
    // Each number's quality and tier from Meta (Autopilot A2): a day old, read again.
    await sweepNumberHealth(pool, o.d).catch((err: unknown) =>
      o.app.log.error({ err }, "whatsapp number health sweep failed"),
    );
    // Each number's token, refreshed through the relay at 30 days (Meta's last 60).
    const relay = relayOf(o.d);
    if (relay)
      await sweepWhatsAppTokens(pool, o.d, relayTokenRefresh(relay)).catch((err: unknown) =>
        o.app.log.error({ err }, "whatsapp token refresh failed"),
      );
    if (!files) return;
    const r = await sweepWhatsAppFiles({ pool, store: files.store, log: o.app.log }).catch((err: unknown) => {
      o.app.log.error({ err }, "whatsapp files sweep failed");
      return null;
    });
    if (r && (r.removed || r.deleted || r.mended)) o.app.log.info(r, "whatsapp files swept");
    if (Date.now() - lastScan < 86_400_000) return;
    lastScan = Date.now();
    await scanWhatsAppFiles({ pool, store: files.store, log: o.app.log }).catch((err: unknown) =>
      o.app.log.error({ err }, "whatsapp files scan failed"),
    );
  };
  const hourly = setInterval(() => void hourlyWork(), 3_600_000);
  // Templates still with WhatsApp after 10 minutes, asked about every 15 (W3b-2): a webhook can be lost.
  const templates = setInterval(
    () =>
      void sweepTemplates(pool, o.d).catch((err: unknown) =>
        o.app.log.error({ err }, "whatsapp templates sweep failed"),
      ),
    15 * 60_000,
  );
  templates.unref();
  hourly.unref();
  return {
    enqueue,
    enqueueMedia,
    enqueueSend,
    enqueueMeaning,
    stop: async () => {
      clearInterval(timer);
      clearInterval(hourly);
      clearInterval(templates);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
