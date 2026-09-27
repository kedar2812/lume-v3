import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
});
afterAll(async () => db.drop());

async function query(role: DbRole, sql: string) {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}

const SOURCE = "00000000-0000-7000-8000-000000000001";
const IMPORT = "00000000-0000-7000-8000-000000000002";

describe("0015_intake", () => {
  it("makes every row write-once per import", async () => {
    await query(
      "lume_owner",
      `INSERT INTO lead_sources (id, type, name) VALUES ('${SOURCE}', 'csv', 'a.csv')`,
    );
    await query(
      "lume_owner",
      `INSERT INTO imports (id, source_id, kind, status, file_sha256, file_name, file_bytes)
       VALUES ('${IMPORT}', '${SOURCE}', 'csv', 'draft', 'x', 'a.csv', 10)`,
    );
    const row = `INSERT INTO import_rows (import_id, row_index, result) VALUES ('${IMPORT}', 2, 'created')
      ON CONFLICT (import_id, row_index) DO NOTHING RETURNING id`;
    expect((await query("lume_app", row)).rowCount).toBe(1);
    expect((await query("lume_app", row)).rowCount).toBe(0);
  });

  it("refuses a status or result outside the lists", async () => {
    await expect(query("lume_owner", `UPDATE imports SET status = 'nope'`)).rejects.toThrow(/imports_status/);
    await expect(query("lume_owner", `UPDATE import_rows SET result = 'nope'`)).rejects.toThrow(
      /import_rows_result/,
    );
  });

  it("lets the worker clear old files and raw rows, and nothing else", async () => {
    await query(
      "lume_worker",
      `UPDATE imports SET file_enc = NULL, purged_at = now() WHERE status = 'draft'`,
    );
    await query("lume_worker", `UPDATE import_rows SET raw_enc = NULL WHERE import_id = '${IMPORT}'`);
    await expect(query("lume_worker", `UPDATE imports SET status = 'done'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(query("lume_worker", `SELECT mapping FROM imports`)).rejects.toThrow(/permission denied/);
    await expect(query("lume_worker", `SELECT problems FROM import_rows`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(query("lume_worker", `SELECT * FROM leads`)).rejects.toThrow(/permission denied/);
  });

  it("lets the worker delete an old import, taking its rows with it", async () => {
    await query("lume_worker", `DELETE FROM imports WHERE id = '${IMPORT}'`);
    expect((await query("lume_owner", `SELECT count(*)::int AS n FROM import_rows`)).rows[0].n).toBe(0);
  });
});
