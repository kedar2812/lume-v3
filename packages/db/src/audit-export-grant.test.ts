import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type TestDatabase } from "./testing";

let db: TestDatabase;
let before: string;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  // An install as it stood before 0108: every migration up to 1.3.0.
  before = await mkdtemp(path.join(tmpdir(), "mig-0107-"));
  for (const f of await readdir(MIGRATIONS_DIR_DEFAULT))
    if (/^\d{4}_/.test(f) && f < "0108")
      await copyFile(path.join(MIGRATIONS_DIR_DEFAULT, f), path.join(before, f));
  await migrate(db.url("lume_owner"), before);
});
afterAll(async () => {
  await db.drop();
  await rm(before, { recursive: true, force: true });
});

async function owner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: db.url("lume_owner") });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

describe("0108: Download the audit log is its own permission (owner 2026-11-14)", () => {
  it("every role that may read the log may download it; others don't", async () => {
    await owner(
      `INSERT INTO permissions (key, "group", label, description, supports_scope, retired) VALUES
         ('audit.view', 'Security', 'See the audit log', '', false, false), ('leads.view', 'Leads', 'View', '', true, false)
       ON CONFLICT (key) DO NOTHING`,
    );
    const roles = {
      admin: "0190e0c0-0000-7000-8000-0000000000a1",
      sales: "0190e0c0-0000-7000-8000-0000000000a2",
    };
    await owner("INSERT INTO roles (id, name) VALUES ($1, 'Admin'), ($2, 'Sales')", [
      roles.admin,
      roles.sales,
    ]);
    await owner(
      `INSERT INTO role_permissions (role_id, permission_key, scope) VALUES ($1, 'audit.view', NULL), ($2, 'leads.view', 'own')`,
      [roles.admin, roles.sales],
    );
    await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
    expect(
      await owner(
        "SELECT role_id, scope FROM role_permissions WHERE permission_key = 'audit.export' ORDER BY role_id",
      ),
    ).toEqual([{ role_id: roles.admin, scope: null }]);
    expect(await owner("SELECT label FROM permissions WHERE key = 'audit.export'")).toEqual([
      { label: "Download the audit log" },
    ]);
  });
});
