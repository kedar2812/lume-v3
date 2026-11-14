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
  // An install as it stood before 0109: every migration up to 1.3.1.
  before = await mkdtemp(path.join(tmpdir(), "mig-0108-"));
  for (const f of await readdir(MIGRATIONS_DIR_DEFAULT))
    if (/^\d{4}_/.test(f) && f < "0109")
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

const U = { maya: "0190e0c0-0000-7000-8000-00000000000a", noor: "0190e0c0-0000-7000-8000-00000000000b" };
const L1 = "0190e0c0-0000-7000-8000-0000000000c1";
const roles = {
  admin: "0190e0c0-0000-7000-8000-0000000000a1",
  sales: "0190e0c0-0000-7000-8000-0000000000a2",
};

type Ctx = { user: string; sweep?: boolean };
async function as<T>(role: "lume_app" | "lume_worker", s: Ctx, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true), set_config('lume.live_sheets_sweep', $2, true)",
      [s.user, s.sweep ? "on" : ""],
    );
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

const G = { maya: "0190e0c0-0000-7000-8000-0000000000d1" };
const S = "0190e0c0-0000-7000-8000-0000000000e1";

describe("0109: live sheets (spec 2026-11-14)", () => {
  it("every role that may export leads may make live sheets; others don't", async () => {
    await owner(
      `INSERT INTO permissions (key, "group", label, description, supports_scope, retired) VALUES
         ('leads.export', 'Leads', 'Export', '', true, false), ('leads.view', 'Leads', 'View', '', true, false)
       ON CONFLICT (key) DO NOTHING`,
    );
    await owner("INSERT INTO roles (id, name) VALUES ($1, 'Admin'), ($2, 'Sales')", [
      roles.admin,
      roles.sales,
    ]);
    await owner(
      `INSERT INTO role_permissions (role_id, permission_key, scope) VALUES ($1, 'leads.export', 'all'), ($2, 'leads.view', 'own')`,
      [roles.admin, roles.sales],
    );
    await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
    expect(
      await owner("SELECT role_id, scope FROM role_permissions WHERE permission_key = 'leads.live_sheets'"),
    ).toEqual([{ role_id: roles.admin, scope: null }]);
    for (const [id, name] of [
      [U.maya, "Maya"],
      [U.noor, "Noor"],
    ])
      await owner("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')", [
        id,
        `${name}@x.test`,
        name,
      ]);
  });

  it("a Google account for live sheets is its person's own; LUME's runs read it with the sweep flag", async () => {
    await as("lume_app", { user: U.maya }, (c) =>
      c.query(
        "INSERT INTO live_sheet_grants (id, user_id, google_email, grant_enc) VALUES ($1, $2, 'm@g.test', '\\x00')",
        [G.maya, U.maya],
      ),
    );
    const seen = (s: Ctx) =>
      as("lume_app", s, async (c) => (await c.query("SELECT id FROM live_sheet_grants")).rows.length);
    expect(await seen({ user: U.maya })).toBe(1);
    expect(await seen({ user: U.noor })).toBe(0);
    expect(await seen({ user: U.noor, sweep: true })).toBe(1);
    await expect(
      as("lume_app", { user: U.noor }, (c) =>
        c.query(
          "INSERT INTO live_sheet_grants (id, user_id, google_email, grant_enc) VALUES (gen_random_uuid(), $1, 'x@g.test', '\\x00')",
          [U.maya],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("a sheet, its rows and one run at a time", async () => {
    await as("lume_app", { user: U.maya }, async (c) => {
      await c.query(
        `INSERT INTO live_sheets (id, name, preset, rule, columns, edits, grant_id, made_by, runs_as)
         VALUES ($1, 'Qualified leads', 'meta', '{}'::jsonb, '[]'::jsonb, 'keep', $2, $3, $3)`,
        [S, G.maya, U.maya],
      );
      await c.query(
        "INSERT INTO live_sheet_runs (id, sheet_id, trigger, status) VALUES (gen_random_uuid(), $1, 'make', 'queued')",
        [S],
      );
      // No foreign key to the lead: a lead purged from the bin still has its row, so LUME can take it out of the sheet.
      await c.query(
        "INSERT INTO live_sheet_rows (sheet_id, lead_id, hash, cells) VALUES ($1, $2, 'h', '[]'::jsonb)",
        [S, L1],
      );
    });
    await expect(
      as("lume_app", { user: U.maya }, (c) =>
        c.query(
          "INSERT INTO live_sheet_runs (id, sheet_id, trigger, status) VALUES (gen_random_uuid(), $1, 'now', 'running')",
          [S],
        ),
      ),
    ).rejects.toThrow(/live_sheet_runs_one/);
    await expect(
      as("lume_app", { user: U.maya }, (c) =>
        c.query("UPDATE live_sheets SET poll_seconds = 30 WHERE id = $1", [S]),
      ),
    ).rejects.toThrow(/live_sheets_poll/);
    await expect(
      as("lume_app", { user: U.maya }, (c) =>
        c.query("UPDATE live_sheets SET status = 'broken' WHERE id = $1", [S]),
      ),
    ).rejects.toThrow(/live_sheets_status/);
  });

  it("the worker can't read a sheet's rows (they hold contact details)", async () => {
    await expect(
      as("lume_worker", { user: U.maya }, (c) => c.query("SELECT cells FROM live_sheet_rows")),
    ).rejects.toThrow(/permission denied/);
  });
});
