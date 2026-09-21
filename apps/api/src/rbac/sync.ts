import type pg from "pg";
import { PERMISSIONS } from "@lume/core";

/** On boot: upsert the code catalog; keys that disappeared are retired, never deleted (roles keep history). */
export async function syncPermissionCatalog(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of PERMISSIONS) {
      await client.query(
        `INSERT INTO permissions (key, "group", label, description, supports_scope, retired) VALUES ($1, $2, $3, $4, $5, false)
         ON CONFLICT (key) DO UPDATE SET "group" = EXCLUDED."group", label = EXCLUDED.label, description = EXCLUDED.description,
           supports_scope = EXCLUDED.supports_scope, retired = false`,
        [p.key, p.group, p.label, p.description, p.scoped],
      );
    }
    await client.query("UPDATE permissions SET retired = true WHERE NOT (key = ANY($1::text[]))", [
      PERMISSIONS.map((p) => p.key),
    ]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
