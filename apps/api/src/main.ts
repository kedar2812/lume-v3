import pg from "pg";
import { apiSchema, loadConfig } from "@lume/config";
import { dbChecks } from "./health";
import { REDACT_PATHS } from "./logger";
import { buildServer } from "./server";

const cfg = loadConfig(apiSchema);
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL_APP, max: 10 });
const app = await buildServer({
  checks: dbChecks(pool),
  logger: { level: cfg.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: "[redacted]" } },
});
await app.listen({ host: "0.0.0.0", port: cfg.API_PORT });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
