import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import {
  MIGRATIONS_DIR_DEFAULT,
  createTestDatabase,
  installQueueSchema,
  migrate,
  type TestDatabase,
} from "@lume/db";
import { makeMaintenanceJobs } from "./maintenance";

let db: TestDatabase;
let pool: pg.Pool;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  pool = new pg.Pool({ connectionString: db.url("lume_worker") });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe("maintenance jobs (as lume_worker)", () => {
  it("purges idempotency keys older than 24 hours and keeps fresh ones", async () => {
    const owner = new pg.Client({ connectionString: db.url("lume_owner") });
    await owner.connect();
    await owner.query(
      "INSERT INTO users (id, email, name, status) VALUES ('0190e0c0-0000-7000-8000-000000000001', 'a@x.com', 'A', 'active')",
    );
    await owner.query(
      `INSERT INTO idempotency_keys (user_id, key, route, request_hash, status, created_at) VALUES
        ('0190e0c0-0000-7000-8000-000000000001', 'old-key-0001', 'POST /x', 'h', 201, now() - interval '25 hours'),
        ('0190e0c0-0000-7000-8000-000000000001', 'new-key-0001', 'POST /x', 'h', 201, now())`,
    );
    await owner.end();
    expect(await makeMaintenanceJobs(pool).purgeIdempotencyKeys()).toBe(1);
    expect((await pool.query("SELECT key FROM idempotency_keys")).rows).toEqual([{ key: "new-key-0001" }]);
  });

  it("clears import files and raw rows 30 days after they finish, and deletes drafts never started after 7", async () => {
    const owner = new pg.Client({ connectionString: db.url("lume_owner") });
    await owner.connect();
    const S = (n: number) => `00000000-0000-7000-8000-0000000000a${n}`;
    const I = (n: number) => `00000000-0000-7000-8000-0000000000b${n}`;
    await owner.query(
      `INSERT INTO lead_sources (id, type, name) VALUES ($1, 'csv', 'x'), ($2, 'csv', 'y'), ($3, 'csv', 'z'), ($4, 'csv', 'w')`,
      [S(1), S(2), S(3), S(4)],
    );
    await owner.query(
      `INSERT INTO imports (id, source_id, kind, status, file_enc, file_sha256, file_name, file_bytes, finished_at, created_at) VALUES
        ($1, $5, 'csv', 'done', 'x', 's', 'old.csv', 1, now() - interval '31 days', now() - interval '31 days'),
        ($2, $6, 'csv', 'done', 'x', 's', 'new.csv', 1, now() - interval '2 days', now() - interval '2 days'),
        ($3, $7, 'csv', 'draft', 'x', 's', 'draft.csv', 1, NULL, now() - interval '8 days'),
        ($4, $8, 'csv', 'running', 'x', 's', 'busy.csv', 1, NULL, now() - interval '40 days')`,
      [I(1), I(2), I(3), I(4), S(1), S(2), S(3), S(4)],
    );
    await owner.query(
      `INSERT INTO import_rows (import_id, row_index, result, raw_enc) VALUES ($1, 2, 'created', 'x')`,
      [I(1)],
    );
    const jobs = makeMaintenanceJobs(pool);
    expect(await jobs.purgeImportFiles()).toEqual({ files: 1, rows: 1, drafts: 1 });
    const left = (
      await owner.query(
        "SELECT id, file_enc IS NULL AS purged, purged_at IS NOT NULL AS stamped FROM imports ORDER BY id",
      )
    ).rows;
    expect(left).toEqual([
      { id: I(1), purged: true, stamped: true },
      { id: I(2), purged: false, stamped: false },
      { id: I(4), purged: false, stamped: false }, // still running: never touched, however old
    ]);
    expect((await owner.query("SELECT raw_enc IS NULL AS purged FROM import_rows")).rows).toEqual([
      { purged: true },
    ]);
    expect(await jobs.purgeImportFiles()).toEqual({ files: 0, rows: 0, drafts: 0 }); // nothing twice
    await owner.end();
  });

  it("deletes sheet sync history after 30 days and refresh records after 1 day, nothing newer", async () => {
    const owner = new pg.Client({ connectionString: db.url("lume_owner") });
    await owner.connect();
    const src = "00000000-0000-7000-8000-0000000000c1";
    await owner.query(
      "INSERT INTO lead_sources (id, type, name, status) VALUES ($1, 'google_sheet', 'Sheet', 'active')",
      [src],
    );
    await owner.query(
      `INSERT INTO source_syncs (id, source_id, trigger, status, requested_at) VALUES
        ('00000000-0000-7000-8000-0000000000d1', $1, 'schedule', 'done', now() - interval '31 days'),
        ('00000000-0000-7000-8000-0000000000d2', $1, 'schedule', 'done', now() - interval '1 day')`,
      [src],
    );
    await owner.query(
      `INSERT INTO source_refreshes (id, requested_by, sync_ids, created_at) VALUES
        ('00000000-0000-7000-8000-0000000000e1', '0190e0c0-0000-7000-8000-000000000001', '{}', now() - interval '2 days'),
        ('00000000-0000-7000-8000-0000000000e2', '0190e0c0-0000-7000-8000-000000000001', '{}', now() - interval '1 hour')`,
    );
    const jobs = makeMaintenanceJobs(pool);
    expect(await jobs.purgeSheetSyncs()).toEqual({ syncs: 1, refreshes: 1, connects: 0 });
    expect(await jobs.purgeSheetSyncs()).toEqual({ syncs: 0, refreshes: 0, connects: 0 });
    await owner.end();
  });
});
