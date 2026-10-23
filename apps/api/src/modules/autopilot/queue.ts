import PgBoss from "pg-boss";
import { sweepNumberHealth } from "../whatsapp/health";
import { allScope } from "../whatsapp/sender";
import { dueRuns, stepRun, type EngineDeps } from "./engine";

/** How long one job keeps stepping a run that keeps finding work, before it hands over to the next. */
const STEP_BUDGET_MS = 30_000;
const SWEEP_MS = 60_000;
const HOUR = 3_600_000;

/**
 * Autopilot's work in the API process (spec 2026-10-19 §2.2: the run lives on the server), beside WhatsApp's: a run is
 * stepped while it finds something to do, then woken when its next message is due (a revealed draft goes in seconds);
 * a sweep each minute catches every run with something due, and a number a running run uses is read from Meta hourly.
 * Two jobs for one run never step at once (stepRun's lock), so a duplicate wake is harmless.
 */
export async function startAutopilotQueue(o: EngineDeps & { connectionString: string }) {
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema: "pgboss",
    migrate: false,
    supervise: false,
    schedule: false,
    max: 3,
  });
  boss.on("error", (err) => o.app.log.error({ err }, "autopilot queue error"));
  await boss.start();
  const pool = o.d.jobPool ?? o.d.pool;
  const kick = async (runId: string, at?: Date) => {
    await (at
      ? boss.sendAfter("autopilot.step", { runId }, { retryLimit: 3, retryDelay: 30 }, at)
      : boss.send("autopilot.step", { runId }, { retryLimit: 3, retryDelay: 30 }));
  };
  await boss.work<{ runId: string }>(
    "autopilot.step",
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (!job) return;
      const started = Date.now();
      while ((await stepRun(o, job.data.runId)) > 0 && Date.now() - started < STEP_BUDGET_MS);
      // The next thing due for this run (a draft to send once revealed, a reply that waits for hours): woken then.
      // Every lead of the run (row-level secured by the lead): read as background work.
      const { rows } = await allScope(pool, (c) =>
        c.query<{ at: Date | null }>(
          `SELECT min(l.next_at) AS at FROM autopilot_leads l JOIN autopilot_runs r ON r.id = l.run_id
            WHERE l.run_id = $1 AND l.active AND r.status = 'running' AND l.next_at > now()`,
          [job.data.runId],
        ),
      );
      const at = rows[0]?.at;
      if (at && at.getTime() - Date.now() < SWEEP_MS) await kick(job.data.runId, at);
    },
  );
  let lastHealth = 0;
  const sweep = async () => {
    try {
      for (const id of await dueRuns(pool, o.d.clock())) await kick(id);
      if (Date.now() - lastHealth >= HOUR) {
        lastHealth = Date.now();
        const { rows } = await pool.query<{ number_id: string }>(
          "SELECT DISTINCT number_id FROM autopilot_runs WHERE status = 'running'",
        );
        if (rows.length)
          await sweepNumberHealth(
            pool,
            o.d,
            HOUR,
            rows.map((r) => r.number_id),
          );
      }
    } catch (err) {
      o.app.log.error({ err }, "autopilot sweep failed");
    }
  };
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref();
  void sweep();
  return {
    kick: (runId: string) => kick(runId),
    async stop() {
      clearInterval(timer);
      await boss.stop({ graceful: true, timeout: 10_000 });
    },
  };
}
