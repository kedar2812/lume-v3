import { loadConfig, migrateSchema } from "@lume/config";
import { QUEUE_NAMES } from "@lume/core";
import { migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";

/** `migrate` container entrypoint: queue schema first (0004 grants on it), then SQL migrations. */
export async function runMigrateCommand(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const cfg = loadConfig(migrateSchema, env);
  await installQueueSchema(cfg.DATABASE_URL_OWNER, QUEUE_NAMES);
  const result = await migrate(cfg.DATABASE_URL_OWNER, cfg.MIGRATIONS_DIR);
  console.log(JSON.stringify({ level: "info", msg: "migrations complete", ...result }));
}
