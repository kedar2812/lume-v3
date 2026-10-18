import PgBoss from "pg-boss";
import type pg from "pg";
import { sweepWhatsApp } from "./inbox";
import { fetchMedia } from "./media";
import { processWhatsAppEvent, type WhatsAppJobDeps } from "./process";

const SWEEP_MS = 60_000;

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
          AND m.created_at > now() - interval '30 days'
        ORDER BY m.created_at LIMIT 200`,
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
    max: 2,
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
  const pool = o.d.jobPool ?? o.d.pool;
  const sweep = async () => {
    try {
      for (const id of await staleEvents(pool)) await enqueue(id);
      for (const id of await staleMedia(pool)) await enqueueMedia(id);
    } catch (err) {
      o.app.log.error({ err }, "whatsapp sweep failed");
    }
  };
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref();
  void sweep();
  // Hourly: Not a lead yet keeps 14 days, processed events 30.
  const hourly = setInterval(
    () =>
      void sweepWhatsApp(pool).catch((err: unknown) => o.app.log.error({ err }, "whatsapp retention failed")),
    3_600_000,
  );
  hourly.unref();
  return {
    enqueue,
    enqueueMedia,
    stop: async () => {
      clearInterval(timer);
      clearInterval(hourly);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
