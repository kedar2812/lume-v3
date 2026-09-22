import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { contactKeyHash } from "./contact-keys";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

/**
 * Report §7.4 / §17 Phase 1 acceptance: row-level security alone — raw SQL as lume_app, no service
 * code — refuses out-of-scope leads and everything hanging off them.
 */
const U = {
  rep: "0190e0c0-0000-7000-8000-00000000000a",
  mate: "0190e0c0-0000-7000-8000-00000000000b",
  other: "0190e0c0-0000-7000-8000-00000000000c",
};
const L = {
  rep: "0190e0c0-0000-7000-8000-0000000000a1",
  mate: "0190e0c0-0000-7000-8000-0000000000b1",
  other: "0190e0c0-0000-7000-8000-0000000000c1",
  none: "0190e0c0-0000-7000-8000-0000000000d1",
};

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  await as("lume_owner", { scope: "all", user: U.rep }, async (c) => {
    for (const [id, email] of [
      [U.rep, "rep@x.com"],
      [U.mate, "mate@x.com"],
      [U.other, "other@x.com"],
    ]) {
      await c.query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')", [
        id,
        email,
        email,
      ]);
    }
    await c.query(
      "INSERT INTO pipelines (id, name, is_default) VALUES ('0190e0c0-0000-7000-8000-0000000000f1', 'P', true)",
    );
    await c.query(
      "INSERT INTO stages (id, pipeline_id, name, kind, position) VALUES ('0190e0c0-0000-7000-8000-0000000000f2', '0190e0c0-0000-7000-8000-0000000000f1', 'New', 'open', 0)",
    );
    for (const [id, owner] of [
      [L.rep, U.rep],
      [L.mate, U.mate],
      [L.other, U.other],
      [L.none, null],
    ] as const) {
      await c.query(
        "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_e164, phone_status, email) VALUES ($1, '0190e0c0-0000-7000-8000-0000000000f1', '0190e0c0-0000-7000-8000-0000000000f2', $2, $5, $3, 'valid', $4)",
        [id, owner, id === L.other ? "+971501234567" : null, `${id}@leads.test`, `Lead ${id.slice(-2)}`],
      );
      await c.query("INSERT INTO activities (id, lead_id, type) VALUES (gen_random_uuid(), $1, 'note')", [
        id,
      ]);
    }
  });
});
afterAll(async () => db.drop());

type Scope = { scope: "own" | "team" | "all" | null; user?: string; team?: string[] };
async function as<T>(role: DbRole, s: Scope, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    await c.query("BEGIN");
    if (s.scope) {
      await c.query(
        "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', $2, true), set_config('lume.team_member_ids', $3, true)",
        [s.user ?? U.rep, s.scope, `{${(s.team ?? []).join(",")}}`],
      );
    }
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
const ids = async (role: DbRole, s: Scope, sql: string) =>
  (await as(role, s, async (c) => (await c.query<{ id: string }>(sql)).rows.map((r) => r.id))).sort();

describe("RLS on leads, by raw SQL as lume_app", () => {
  it("own scope sees only my leads; team adds my team's; all sees everything incl. unassigned", async () => {
    expect(await ids("lume_app", { scope: "own" }, "SELECT id FROM leads")).toEqual([L.rep]);
    expect(await ids("lume_app", { scope: "team", team: [U.rep, U.mate] }, "SELECT id FROM leads")).toEqual(
      [L.rep, L.mate].sort(),
    );
    expect(await ids("lume_app", { scope: "all" }, "SELECT id FROM leads")).toEqual(Object.values(L).sort());
  });

  it("fails closed: no request scope, no rows — even for the table owner", async () => {
    expect(await ids("lume_app", { scope: null }, "SELECT id FROM leads")).toEqual([]);
    expect(await ids("lume_owner", { scope: null }, "SELECT id FROM leads")).toEqual([]);
  });

  it("child tables inherit the lead's visibility", async () => {
    const rows = await as(
      "lume_app",
      { scope: "own" },
      async (c) => (await c.query("SELECT lead_id FROM activities")).rows,
    );
    expect(rows).toEqual([{ lead_id: L.rep }]);
  });

  it("a rep cannot create a lead for someone else, or hang an activity off one they can't see", async () => {
    await expect(
      as("lume_app", { scope: "own" }, (c) =>
        c.query(
          "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name) VALUES (gen_random_uuid(), '0190e0c0-0000-7000-8000-0000000000f1', '0190e0c0-0000-7000-8000-0000000000f2', $1, 'x')",
          [U.other],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as("lume_app", { scope: "own" }, (c) =>
        c.query("INSERT INTO activities (id, lead_id, type) VALUES (gen_random_uuid(), $1, 'note')", [
          L.other,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("updates reach only visible leads, but may hand a lead away; deletes and history rewrites do nothing", async () => {
    const touched = await as(
      "lume_app",
      { scope: "own" },
      async (c) => (await c.query("UPDATE leads SET name = 'hacked' WHERE id = $1", [L.other])).rowCount,
    );
    expect(touched).toBe(0);
    // Without the handoff allowance the new row fails the read policy (Postgres checks it for UPDATE ... WHERE).
    await expect(
      as("lume_app", { scope: "own" }, (c) =>
        c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.mate, L.rep]),
      ),
    ).rejects.toThrow(/row-level security/);
    // A handoff can't be used to take someone else's lead: the existing row must already be visible.
    const stolen = await as("lume_app", { scope: "own" }, async (c) => {
      await c.query("SELECT set_config('lume.handoff_lead', $1, true)", [L.other]);
      return (await c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.rep, L.other])).rowCount;
    });
    expect(stolen).toBe(0);
    await as("lume_app", { scope: "own" }, async (c) => {
      await c.query("SELECT set_config('lume.handoff_lead', $1, true)", [L.rep]);
      await c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.mate, L.rep]);
    });
    expect(await ids("lume_app", { scope: "own" }, "SELECT id FROM leads")).toEqual([]); // gone from my view at once
    const deleted = await as(
      "lume_app",
      { scope: "all" },
      async (c) => (await c.query("DELETE FROM leads")).rowCount,
    );
    expect(deleted).toBe(0);
    await expect(
      as("lume_app", { scope: "all" }, (c) => c.query("UPDATE activities SET type = 'x'")),
    ).rejects.toThrow(/permission denied/);
    await as("lume_app", { scope: "all" }, (c) =>
      c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.rep, L.rep]),
    );
  });

  it("the backup role reads every row (pg_dump --enable-row-security)", async () => {
    expect(await ids("lume_readonly_backup", { scope: null }, "SELECT id FROM leads")).toEqual(
      Object.values(L).sort(),
    );
  });
});

describe("contact keys (cross-scope duplicate detection without exposing contacts)", () => {
  it("hold only hashes, stay in sync, and are readable regardless of scope", async () => {
    const rows = await as(
      "lume_app",
      { scope: "own" },
      async (c) =>
        (await c.query("SELECT lead_id, kind, key_hash FROM lead_contact_keys WHERE kind = 'phone'")).rows,
    );
    expect(rows).toEqual([
      { lead_id: L.other, kind: "phone", key_hash: contactKeyHash("phone", "+971501234567") },
    ]);
    await as("lume_app", { scope: "all" }, (c) =>
      c.query("UPDATE leads SET deleted_at = now() WHERE id = $1", [L.other]),
    );
    const after = await as(
      "lume_app",
      { scope: "own" },
      async (c) => (await c.query("SELECT 1 FROM lead_contact_keys WHERE lead_id = $1", [L.other])).rowCount,
    );
    expect(after).toBe(0); // deleted leads no longer count as duplicates
  });
});
