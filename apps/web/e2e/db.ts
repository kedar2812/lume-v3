import path from "node:path";
import pg from "pg";
import { QUEUE_NAMES } from "@lume/core";
import { adminUrl, installQueueSchema, migrate, roleUrl } from "@lume/db";

// The database name is written out in each statement below: identifiers cannot be query parameters.
const DB = "lume_e2e";

/**
 * A brand-new installation for each run: the database is dropped and created again, migrated, and given
 * the queue schema, with no users, so /setup is genuinely a first run. (Dropping is simpler and more
 * honest than truncating: nothing from a previous run can leak in, including the append-only audit log.)
 */
export async function resetE2eDatabase(repoRoot: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query("DROP DATABASE IF EXISTS lume_e2e WITH (FORCE)");
    await admin.query("CREATE DATABASE lume_e2e OWNER lume_owner");
    await admin.query("REVOKE ALL ON DATABASE lume_e2e FROM PUBLIC");
    await admin.query("GRANT CONNECT ON DATABASE lume_e2e TO lume_app, lume_worker, lume_readonly_backup");
  } finally {
    await admin.end();
  }
  const ownerUrl = roleUrl("lume_owner", DB);
  await installQueueSchema(ownerUrl, QUEUE_NAMES);
  // Explicit: this runs from a bundle, where a path relative to the module would point elsewhere.
  await migrate(ownerUrl, path.join(repoRoot, "packages/db/migrations"));
}
