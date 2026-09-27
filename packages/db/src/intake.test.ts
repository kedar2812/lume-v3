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

const SHEET = "00000000-0000-7000-8000-00000000f001";
describe("0016_sheets", () => {
  it("keeps a sheet source's sync state, with sane defaults and limits", async () => {
    await query(
      "lume_owner",
      `INSERT INTO lead_sources (id, type, name, status) VALUES ('${SHEET}', 'google_sheet', 'Enquiries', 'draft')`,
    );
    const { rows } = await query(
      "lume_owner",
      `SELECT poll_seconds, rows_read, config_version, baseline, new_columns FROM lead_sources WHERE id = '${SHEET}'`,
    );
    expect(rows[0]).toEqual({
      poll_seconds: 120,
      rows_read: 0,
      config_version: 1,
      baseline: false,
      new_columns: [],
    });
    await expect(
      query("lume_owner", `UPDATE lead_sources SET poll_seconds = 30 WHERE id = '${SHEET}'`),
    ).rejects.toThrow(/lead_sources_poll/);
  });

  it("deals with each sheet row once, per source", async () => {
    await query(
      "lume_owner",
      `INSERT INTO source_rows (source_id, fingerprint, result, row_number) VALUES ('${SHEET}', 'fp1', 'created', 2)`,
    );
    await expect(
      query(
        "lume_owner",
        `INSERT INTO source_rows (source_id, fingerprint, result, row_number) VALUES ('${SHEET}', 'fp1', 'error', 3)`,
      ),
    ).rejects.toThrow(/source_rows_once/);
    await query(
      "lume_owner",
      `INSERT INTO imports (id, source_id, kind, status, file_sha256, file_name, file_bytes)
       VALUES ('00000000-0000-7000-8000-00000000f002', '${SHEET}', 'sheet', 'draft', 'x', 'Enquiries', 1)`,
    );
  });

  it("lets the worker sweep old sync history, and nothing else", async () => {
    await expect(query("lume_worker", "SELECT fingerprint FROM source_rows")).rejects.toThrow(/permission/);
    await query("lume_worker", "DELETE FROM source_syncs WHERE requested_at < now() - interval '30 days'");
    await query("lume_worker", "DELETE FROM source_refreshes WHERE created_at < now() - interval '1 day'");
  });

  it("adds the seen-Leads marker and the integrations switchboard", async () => {
    const u = await query(
      "lume_owner",
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'leads_seen_at'",
    );
    expect(u.rowCount).toBe(1);
    const s = await query(
      "lume_owner",
      "SELECT column_default FROM information_schema.columns WHERE table_name = 'settings' AND column_name = 'integrations'",
    );
    expect(s.rows[0].column_default).toContain("{}");
  });
});

describe("0018_oauth_connects", () => {
  it("keeps one pending connect per nonce, and the worker can't read it", async () => {
    await query(
      "lume_owner",
      "INSERT INTO users (id, email, name, status) VALUES ('00000000-0000-7000-8000-00000000c0c0', 'c@x.test', 'C', 'active')",
    );
    await query(
      "lume_owner",
      "INSERT INTO oauth_connects (id, user_id, nonce_hash) VALUES ('00000000-0000-7000-8000-00000000c0c1', '00000000-0000-7000-8000-00000000c0c0', 'h1')",
    );
    await expect(
      query(
        "lume_owner",
        "INSERT INTO oauth_connects (id, user_id, nonce_hash) VALUES ('00000000-0000-7000-8000-00000000c0c2', '00000000-0000-7000-8000-00000000c0c0', 'h1')",
      ),
    ).rejects.toThrow(/oauth_connects_nonce/);
    await expect(query("lume_worker", "SELECT grant_enc FROM oauth_connects")).rejects.toThrow(/permission/);
  });
});
