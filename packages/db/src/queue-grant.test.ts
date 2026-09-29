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
  // An install as it stood before 0030: every migration up to the send queue.
  before = await mkdtemp(path.join(tmpdir(), "mig-0029-"));
  for (const f of await readdir(MIGRATIONS_DIR_DEFAULT))
    if (/^\d{4}_/.test(f) && f < "0030")
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

describe("0030: whoever messages leads one at a time may run a send queue over them", () => {
  it("existing roles gain the queue at the scope they send at; others don't", async () => {
    await owner(
      `INSERT INTO permissions (key, "group", label, description, supports_scope, retired) VALUES
         ('messages.send', 'Messaging', 'Send', '', true, false), ('leads.view', 'Leads', 'View', '', true, false)
       ON CONFLICT (key) DO NOTHING`,
    );
    const roles = {
      sales: "0190e0c0-0000-7000-8000-0000000000a1",
      team: "0190e0c0-0000-7000-8000-0000000000a2",
      viewer: "0190e0c0-0000-7000-8000-0000000000a3",
    };
    await owner("INSERT INTO roles (id, name) VALUES ($1, 'Sales'), ($2, 'Team lead'), ($3, 'Viewer')", [
      roles.sales,
      roles.team,
      roles.viewer,
    ]);
    await owner(
      `INSERT INTO role_permissions (role_id, permission_key, scope) VALUES
         ($1, 'messages.send', 'own'), ($2, 'messages.send', 'team'), ($3, 'leads.view', 'all')`,
      [roles.sales, roles.team, roles.viewer],
    );
    await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
    const rows = await owner<{ role_id: string; scope: string }>(
      "SELECT role_id, scope FROM role_permissions WHERE permission_key = 'messages.send_queue' ORDER BY role_id",
    );
    expect(rows).toEqual([
      { role_id: roles.sales, scope: "own" },
      { role_id: roles.team, scope: "team" },
    ]);
  });
});
