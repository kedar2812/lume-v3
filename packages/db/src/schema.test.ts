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

async function as<T>(role: DbRole, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

describe("Phase 0 schema and grants", () => {
  it("installs citext and pg_trgm", async () => {
    const rows = await as<{ extname: string }>("lume_app", "SELECT extname FROM pg_extension ORDER BY 1");
    expect(rows.map((r) => r.extname)).toEqual(expect.arrayContaining(["citext", "pg_trgm"]));
  });

  it("lets api and worker read the queue schema; creates every queue", async () => {
    for (const role of ["lume_app", "lume_worker"] as const) {
      expect((await as<{ version: number }>(role, "SELECT version FROM pgboss.version")).length).toBe(1);
    }
    const queues = await as<{ name: string }>("lume_worker", "SELECT name FROM pgboss.queue ORDER BY 1");
    // Our queues plus pg-boss's internal cron queue, which only lume_owner may create.
    expect(queues.map((q) => q.name).sort()).toEqual([...QUEUE_NAMES, "__pgboss__send-it"].sort());
  });

  it("restore-test results: worker inserts, api cannot, nobody updates", async () => {
    await as(
      "lume_worker",
      "INSERT INTO ops_restore_tests (started_at, finished_at, backup_name, ok) VALUES (now(), now(), 'x', true)",
    );
    await expect(
      as(
        "lume_app",
        "INSERT INTO ops_restore_tests (started_at, finished_at, backup_name, ok) VALUES (now(), now(), 'x', true)",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(as("lume_worker", "UPDATE ops_restore_tests SET ok = false")).rejects.toThrow(
      /permission denied/,
    );
    expect((await as<{ ok: boolean }>("lume_app", "SELECT ok FROM ops_restore_tests")).length).toBe(1);
  });

  it("backup role reads everything but writes nothing", async () => {
    expect((await as("lume_readonly_backup", "SELECT name FROM schema_migrations")).length).toBe(4);
    expect((await as("lume_readonly_backup", "SELECT count(*) FROM pgboss.job")).length).toBe(1);
    await expect(as("lume_readonly_backup", "DELETE FROM ops_restore_tests")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("app and worker cannot create tables in public", async () => {
    await expect(as("lume_app", "CREATE TABLE sneaky (id int)")).rejects.toThrow(/permission denied/);
    await expect(as("lume_worker", "CREATE TABLE sneaky (id int)")).rejects.toThrow(/permission denied/);
  });
});
