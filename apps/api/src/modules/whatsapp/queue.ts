import PgBoss from "pg-boss";
import type pg from "pg";
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
export async function startWhatsAppQueue(
  o: WhatsAppJobDeps & { connectionString: string; media?: (id: string) => Promise<void> },
) {
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
  if (o.media) {
    const fetchOne = o.media;
    await boss.work<{ id: string }>(
      "whatsapp.media",
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async ([job]) => {
        if (job) await fetchOne(job.data.id);
      },
    );
  }
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
    } catch (err) {
      o.app.log.error({ err }, "whatsapp sweep failed");
    }
  };
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref();
  void sweep();
  return {
    enqueue,
    enqueueMedia,
    stop: async () => {
      clearInterval(timer);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
