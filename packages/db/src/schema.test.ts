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

describe("W3b-1 file library", () => {
  const sha = (c: string) => c.repeat(64);
  const refsOf = async (s: string) =>
    (await as<{ refs: number }>("lume_owner", "SELECT refs FROM whatsapp_files WHERE sha256 = $1", [s]))[0]!
      .refs;
  const file = (id: string, s: string, name: string) =>
    as(
      "lume_app",
      "INSERT INTO message_files (id, sha256, name, mime, kind, size) VALUES ($1, $2, $3, 'application/pdf', 'document', 10)",
      [id, s, name],
    );

  it("a library file holds its stored file: refs go up with the row and down when it's deleted", async () => {
    await as("lume_app", "INSERT INTO whatsapp_files (sha256, size) VALUES ($1, 10)", [sha("a")]);
    await file("00000000-0000-7000-8000-0000000000f1", sha("a"), "Brochure.pdf");
    expect(await refsOf(sha("a"))).toBe(1);
    // Archiving is not deleting: the file stays held, so a message that sent it still opens.
    await as("lume_app", "UPDATE message_files SET archived_at = now() WHERE id = $1", [
      "00000000-0000-7000-8000-0000000000f1",
    ]);
    expect(await refsOf(sha("a"))).toBe(1);
    await as("lume_app", "DELETE FROM message_files WHERE id = $1", ["00000000-0000-7000-8000-0000000000f1"]);
    expect(await refsOf(sha("a"))).toBe(0);
  });

  it("two live library files can't share a name (in any case), an archived one can", async () => {
    await as("lume_app", "INSERT INTO whatsapp_files (sha256, size) VALUES ($1, 10)", [sha("b")]);
    await file("00000000-0000-7000-8000-0000000000f2", sha("b"), "Price list.pdf");
    await expect(file("00000000-0000-7000-8000-0000000000f3", sha("b"), "price LIST.pdf")).rejects.toThrow(
      /message_files_live_name/,
    );
    await as("lume_app", "UPDATE message_files SET archived_at = now() WHERE id = $1", [
      "00000000-0000-7000-8000-0000000000f2",
    ]);
    await file("00000000-0000-7000-8000-0000000000f3", sha("b"), "price LIST.pdf");
  });

  it("the worker can't read the library; the backup role can", async () => {
    await expect(as("lume_worker", "SELECT id FROM message_files")).rejects.toThrow(/permission denied/);
    expect((await as("lume_readonly_backup", "SELECT id FROM message_files")).length).toBeGreaterThan(0);
  });
});

describe("W3b-2 template submissions", () => {
  const T = "00000000-0000-7000-8000-0000000000b1";
  const V = "00000000-0000-7000-8000-0000000000b2";
  const submit = (id: string, waba = "WABA1", language = "en") =>
    as(
      "lume_app",
      `INSERT INTO whatsapp_template_submissions (id, template_version_id, waba_id, language, category, meta_name, status)
       VALUES ($1, $2, $3, $4, 'MARKETING', 'hello_v1', 'pending')`,
      [id, V, waba, language],
    );

  it("a template version is submitted once per WhatsApp account and language", async () => {
    await as(
      "lume_app",
      "INSERT INTO message_templates (id, name, category) VALUES ($1, 'Visit hello', 'first_touch')",
      [T],
    );
    await as(
      "lume_app",
      "INSERT INTO template_versions (id, template_id, body) VALUES ($1, $2, 'Hi there')",
      [V, T],
    );
    await submit("00000000-0000-7000-8000-0000000000b3");
    await expect(submit("00000000-0000-7000-8000-0000000000b4")).rejects.toThrow(/duplicate key/);
    await submit("00000000-0000-7000-8000-0000000000b5", "WABA2");
    await submit("00000000-0000-7000-8000-0000000000b6", "WABA1", "hi");
    await expect(
      as(
        "lume_app",
        `INSERT INTO whatsapp_template_submissions (id, template_version_id, waba_id, language, category, meta_name, status)
         VALUES (gen_random_uuid(), $1, 'WABA3', 'en', 'AUTHENTICATION', 'x_v1', 'pending')`,
        [V],
      ),
    ).rejects.toThrow(/whatsapp_template_submissions_category_check/);
  });

  it("a lead can be marked as having turned off marketing messages", async () => {
    const cols = await as<{ column_name: string }>(
      "lume_owner",
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'whatsapp_marketing_off_at'",
    );
    expect(cols).toHaveLength(1);
  });

  it("an outbox message may carry a template instead of words or a file", async () => {
    const check = await as<{ def: string }>(
      "lume_owner",
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       WHERE c.conrelid = 'whatsapp_outbox'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%media_id%'`,
    );
    expect(check.map((c) => c.def).join(" ")).toContain("submission_id IS NOT NULL");
    const cols = await as<{ column_name: string }>(
      "lume_owner",
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'whatsapp_outbox' ORDER BY column_name",
    );
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(["submission_id", "params", "cost", "cost_currency", "paid"]),
    );
  });

  it("the worker can't read submissions; the backup role can", async () => {
    await expect(as("lume_worker", "SELECT id FROM whatsapp_template_submissions")).rejects.toThrow(
      /permission denied/,
    );
    expect(
      (await as("lume_readonly_backup", "SELECT id FROM whatsapp_template_submissions")).length,
    ).toBeGreaterThan(0);
  });
});

describe("W3b-2 paid messages this month", () => {
  it("anyone in LUME can count them, every lead's, and learns nothing else", async () => {
    const [{ n }] = await as<{ n: number }>(
      "lume_app",
      "SELECT lume_whatsapp_paid_count(now() - interval '1 day', now() + interval '1 day') AS n",
    );
    expect(n).toBe(0);
    await expect(as("lume_worker", "SELECT lume_whatsapp_paid_count(now(), now())")).rejects.toThrow(
      /permission denied/,
    );
  });
});
