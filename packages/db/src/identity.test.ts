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

async function as<T = Record<string, unknown>>(
  role: DbRole,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

describe("audit_log is append-only (report §12.4)", () => {
  it("the app can insert and read but never change or remove entries", async () => {
    await as("lume_app", "INSERT INTO audit_log (action, entity_type) VALUES ('test.event', 'test')");
    expect((await as("lume_app", "SELECT action FROM audit_log")).length).toBe(1);
    await expect(as("lume_app", "UPDATE audit_log SET action = 'x'")).rejects.toThrow(
      /permission denied|append-only/,
    );
    await expect(as("lume_app", "DELETE FROM audit_log")).rejects.toThrow(/permission denied|append-only/);
    await expect(as("lume_app", "TRUNCATE audit_log")).rejects.toThrow(/permission denied/);
  });

  it("even the schema owner cannot rewrite history", async () => {
    await expect(as("lume_owner", "UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(as("lume_owner", "DELETE FROM audit_log")).rejects.toThrow(/append-only/);
  });
});

describe("identity constraints", () => {
  it("allows exactly one owner and one settings row", async () => {
    await as(
      "lume_app",
      "INSERT INTO users (id, email, name, status, is_owner) VALUES (gen_random_uuid(), 'a@x.com', 'A', 'active', true)",
    );
    await expect(
      as(
        "lume_app",
        "INSERT INTO users (id, email, name, status, is_owner) VALUES (gen_random_uuid(), 'b@x.com', 'B', 'active', true)",
      ),
    ).rejects.toThrow(/users_one_owner/);
    await expect(
      as(
        "lume_app",
        "INSERT INTO settings (id, business_name, timezone, currency, default_country_iso, industry_preset) VALUES (2, 'x', 'UTC', 'AED', 'AE', 'general')",
      ),
    ).rejects.toThrow(/check/i);
  });

  it("emails are case-insensitive and unique", async () => {
    await expect(
      as(
        "lume_app",
        "INSERT INTO users (id, email, name, status) VALUES (gen_random_uuid(), 'A@X.COM', 'A2', 'active')",
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("stamps updated_at on change", async () => {
    const [before] = await as<{ updated_at: Date }>(
      "lume_app",
      "SELECT updated_at FROM users WHERE email = 'a@x.com'",
    );
    await new Promise((r) => setTimeout(r, 20));
    await as("lume_app", "UPDATE users SET name = 'A!' WHERE email = 'a@x.com'");
    const [after] = await as<{ updated_at: Date }>(
      "lume_app",
      "SELECT updated_at FROM users WHERE email = 'a@x.com'",
    );
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
  });
});

describe("RLS helper functions fail closed", () => {
  it("return null/empty without settings and the values inside a scoped transaction", async () => {
    const [none] = await as<{ u: string | null; s: string | null; t: string[] }>(
      "lume_app",
      "SELECT lume_user() AS u, lume_scope() AS s, lume_team_members() AS t",
    );
    expect(none).toEqual({ u: null, s: null, t: [] });
    const c = new pg.Client({ connectionString: db.url("lume_app") });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'team', true), set_config('lume.team_member_ids', $2, true)",
        ["0190e0c0-0000-7000-8000-000000000001", "{0190e0c0-0000-7000-8000-000000000002}"],
      );
      const { rows } = await c.query(
        "SELECT lume_user()::text AS u, lume_scope() AS s, lume_team_members()::text[] AS t",
      );
      expect(rows[0]).toEqual({
        u: "0190e0c0-0000-7000-8000-000000000001",
        s: "team",
        t: ["0190e0c0-0000-7000-8000-000000000002"],
      });
      await c.query("COMMIT");
      const after = await c.query("SELECT lume_user() AS u");
      expect(after.rows[0].u).toBeNull(); // SET LOCAL ended with the transaction
    } finally {
      await c.end();
    }
  });
});
