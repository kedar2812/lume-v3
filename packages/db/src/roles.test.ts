import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { adminUrl, createTestDatabase, type TestDatabase } from "./testing";

describe("postgres roles (report §12.4)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it("no LUME role is superuser or bypasses RLS; only lume_restore may create databases", async () => {
    const c = new pg.Client({ connectionString: adminUrl() });
    await c.connect();
    const { rows } = await c.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      scram: boolean;
    }>(
      `SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreatedb, a.rolpassword LIKE 'SCRAM-SHA-256$%' AS scram
         FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid
        WHERE r.rolname LIKE 'lume\\_%' ORDER BY r.rolname`,
    );
    await c.end();
    expect(rows.map((r) => r.rolname)).toEqual([
      "lume_app",
      "lume_owner",
      "lume_readonly_backup",
      "lume_restore",
      "lume_worker",
    ]);
    for (const r of rows) {
      expect(r.rolsuper, r.rolname).toBe(false);
      expect(r.rolbypassrls, r.rolname).toBe(false);
      expect(r.rolcreatedb, r.rolname).toBe(r.rolname === "lume_restore");
      expect(r.scram, r.rolname).toBe(true);
    }
  });

  it("every role can connect to a LUME database with its own password", async () => {
    for (const role of ["lume_owner", "lume_app", "lume_worker", "lume_readonly_backup"] as const) {
      const c = new pg.Client({ connectionString: db.url(role) });
      await c.connect();
      const { rows } = await c.query<{ u: string }>("SELECT current_user AS u");
      await c.end();
      expect(rows[0]?.u).toBe(role);
    }
  });

  it("the worker can do what its WhatsApp files backup does, and still can't rewrite what happened (owner, 2026-10-27)", async () => {
    // The files backup recorded its result as lume_worker into ops_events, which 0025 kept from the worker: every run
    // failed with "permission denied for table ops_events" and System health said the files never reached the backup.
    await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
    await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
    const c = new pg.Client({ connectionString: db.url("lume_worker") });
    await c.connect();
    try {
      await c.query("SELECT files_salt AS s FROM settings WHERE id = 1");
      await c.query(
        "SELECT sha256 FROM whatsapp_files_gone WHERE gone_at < now() ORDER BY gone_at LIMIT 1000",
      );
      await c.query("DELETE FROM whatsapp_files_gone WHERE sha256 = $1", ["0".repeat(64)]);
      await c.query("INSERT INTO ops_events (kind, ok, detail) VALUES ('backup.files', true, '{}')");
      await expect(c.query("UPDATE ops_events SET ok = false")).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });
});
