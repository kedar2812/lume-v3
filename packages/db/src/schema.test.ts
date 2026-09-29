import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, listMigrations, migrate } from "./migrate";
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

  it("3C ops events: the app writes and reads them, nobody changes one, the worker only clears old ones", async () => {
    await as("lume_app", "INSERT INTO ops_events (kind, ok, detail) VALUES ('digest.failed', false, '{}')");
    await expect(
      as("lume_app", "INSERT INTO ops_events (kind, ok) VALUES ('Not A Kind!', true)"),
    ).rejects.toThrow(/ops_events_kind_check/);
    await expect(as("lume_app", "UPDATE ops_events SET ok = true")).rejects.toThrow(/permission denied/);
    await expect(as("lume_app", "DELETE FROM ops_events")).rejects.toThrow(/permission denied/);
    await expect(as("lume_worker", "INSERT INTO ops_events (kind, ok) VALUES ('x.y', true)")).rejects.toThrow(
      /permission denied/,
    );
    await as("lume_worker", "DELETE FROM ops_events WHERE at < now() - interval '30 days'");
    expect((await as("lume_readonly_backup", "SELECT kind FROM ops_events")).length).toBe(1);
  });

  it("4A templates: a version is never changed; a category must be one of five; backups read both", async () => {
    await as(
      "lume_app",
      "INSERT INTO message_templates (id, name, category) VALUES ('00000000-0000-7000-8000-0000000000a1', 'Hello', 'first_touch')",
    );
    await as(
      "lume_app",
      "INSERT INTO template_versions (id, template_id, body) VALUES ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000000a1', 'Hi')",
    );
    await expect(as("lume_app", "UPDATE template_versions SET body = 'Changed'")).rejects.toThrow(
      /permission denied/,
    );
    await expect(as("lume_app", "DELETE FROM template_versions")).rejects.toThrow(/permission denied/);
    await expect(
      as(
        "lume_app",
        "INSERT INTO message_templates (id, name, category) VALUES (gen_random_uuid(), 'X', 'spam')",
      ),
    ).rejects.toThrow(/message_templates_category_check/);
    expect(await as("lume_readonly_backup", "SELECT id FROM template_versions")).toHaveLength(1);
    expect(await as("lume_readonly_backup", "SELECT id FROM message_templates")).toHaveLength(1);
  });

  it("backup role reads everything but writes nothing", async () => {
    expect((await as("lume_readonly_backup", "SELECT name FROM schema_migrations")).length).toBe(
      (await listMigrations(MIGRATIONS_DIR_DEFAULT)).length,
    );
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
