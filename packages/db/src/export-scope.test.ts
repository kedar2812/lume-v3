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
  // An install as it stood before 0117: Export's scope wasn't enforced, so "own" (the default when ticked) took out
  // every lead the role sees.
  before = await mkdtemp(path.join(tmpdir(), "mig-0116-"));
  for (const f of await readdir(MIGRATIONS_DIR_DEFAULT))
    if (/^\d{4}_/.test(f) && f < "0117")
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

describe("0117: Export keeps what it took out before its scope was enforced (owner 2026-11-18)", () => {
  it("an Export left at own takes the role's view scope; a team chosen on purpose, and a role seeing its own, stay", async () => {
    await owner(
      `INSERT INTO permissions (key, "group", label, description, supports_scope, retired) VALUES
         ('leads.view', 'Leads', 'View', '', true, false), ('leads.export', 'Leads', 'Export', '', true, false)
       ON CONFLICT (key) DO NOTHING`,
    );
    const r = (n: number) => `0190e0c0-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`;
    const names = [
      "All own",
      "All null",
      "Team null",
      "Own own",
      "All team",
      "No view",
      "View only",
      "Export only",
    ];
    for (const [i, name] of names.entries())
      await owner("INSERT INTO roles (id, name) VALUES ($1, $2)", [r(i), name]);
    await owner(
      `INSERT INTO role_permissions (role_id, permission_key, scope) VALUES
         ($1, 'leads.view', 'all'),  ($1, 'leads.export', 'own'),
         ($2, 'leads.view', 'all'),  ($2, 'leads.export', NULL),
         ($3, 'leads.view', 'team'), ($3, 'leads.export', NULL),
         ($4, 'leads.view', 'own'),  ($4, 'leads.export', 'own'),
         ($5, 'leads.view', 'all'),  ($5, 'leads.export', 'team'),
                                     ($6, 'leads.export', 'own'),
         ($7, 'leads.view', 'all'),
         ($8, 'leads.view', 'own'),  ($8, 'leads.export', 'own')`,
      [r(0), r(1), r(2), r(3), r(4), r(5), r(6), r(7)],
    );
    // Someone holding "View only" (sees everyone) and "Export only" (exports, sees their own) took out everyone: a
    // person's permissions are all their roles together (review 2026-11-18).
    const u = "0190e0c0-0000-7000-8000-000000000301";
    await owner(
      "INSERT INTO users (id, email, name, status) VALUES ($1, 'two.roles@example.test', 'Two Roles', 'active')",
      [u],
    );
    await owner("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($1, $3)", [u, r(6), r(7)]);
    await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
    const rows = await owner<{ name: string; scope: string | null }>(
      `SELECT r.name, p.scope FROM role_permissions p JOIN roles r ON r.id = p.role_id
        WHERE p.permission_key = 'leads.export' ORDER BY r.id`,
    );
    expect(rows).toEqual([
      { name: "All own", scope: "all" },
      { name: "All null", scope: "all" },
      { name: "Team null", scope: "team" },
      { name: "Own own", scope: "own" },
      { name: "All team", scope: "team" },
      { name: "No view", scope: "own" },
      { name: "Export only", scope: "all" },
    ]);
  });
});
