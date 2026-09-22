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
});
