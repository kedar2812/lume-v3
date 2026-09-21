import pg from "pg";
import pino from "pino";
import { loadConfig, workerSchema } from "@lume/config";
import { startQueue } from "./boss";
import { realExec } from "./exec";
import { makeOpsJobs } from "./ops";

const cfg = loadConfig(workerSchema);
const log = pino({
  level: cfg.LOG_LEVEL,
  redact: { paths: ["*.password", "*.token", "*.phone", "*.email"], censor: "[redacted]" },
});
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL_WORKER, max: 5 });

const passthrough = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith("RCLONE_CONFIG_")),
) as Record<string, string>;
const jobs = makeOpsJobs({
  exec: realExec,
  remote: cfg.RCLONE_REMOTE,
  scriptsDir: cfg.OPS_SCRIPTS_DIR,
  now: () => new Date(),
  env: {
    ...passthrough,
    DATABASE_URL_BACKUP: cfg.DATABASE_URL_BACKUP,
    DATABASE_URL_RESTORE: cfg.DATABASE_URL_RESTORE,
    BACKUP_AGE_RECIPIENTS: cfg.BACKUP_AGE_RECIPIENTS.join(","),
    BACKUP_AGE_IDENTITY_FILE: cfg.BACKUP_AGE_IDENTITY_FILE,
  },
  recordRestoreTest: async (r) => {
    await pool.query(
      "INSERT INTO ops_restore_tests (started_at, finished_at, backup_name, ok, details) VALUES ($1, $2, $3, $4, $5)",
      [r.startedAt, r.finishedAt, r.backupName, r.ok, JSON.stringify(r.details)],
    );
  },
});

const [command, target] = process.argv.slice(2);
if (command === "run-now") {
  // Operator/acceptance entry: run one ops job immediately, outside the queue.
  try {
    if (target === "ops.backup") log.info(await jobs.backup(), "backup complete");
    else if (target === "ops.restore-test") {
      await jobs.restoreTest();
      log.info({}, "restore test passed");
    } else throw new Error(`unknown job ${target ?? "(none)"}`);
    await pool.end();
    process.exit(0);
  } catch (err) {
    log.error({ err }, "run-now failed");
    await pool.end();
    process.exit(1);
  }
} else {
  const boss = await startQueue({ connectionString: cfg.DATABASE_URL_WORKER, jobs, log });
  log.info({}, "worker started");
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      await boss.stop({ graceful: true, timeout: 20_000, wait: true });
      await pool.end();
      process.exit(0);
    });
  }
}
