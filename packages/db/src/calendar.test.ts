import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

/** Phase 5A (spec §2.4): meetings follow their lead; an unlinked one, and a calendar connection, are the person's own. */
const U = {
  rep: "0190e0c0-0000-7000-8000-00000000000a",
  other: "0190e0c0-0000-7000-8000-00000000000c",
};
const L = { rep: "0190e0c0-0000-7000-8000-0000000000a1", other: "0190e0c0-0000-7000-8000-0000000000c1" };
const C = { rep: "0190e0c0-0000-7000-8000-0000000000e1", other: "0190e0c0-0000-7000-8000-0000000000e2" };
const M = {
  repLead: "0190e0c0-0000-7000-8000-000000000101",
  otherLead: "0190e0c0-0000-7000-8000-000000000102",
  otherUnlinked: "0190e0c0-0000-7000-8000-000000000103",
  repUnlinked: "0190e0c0-0000-7000-8000-000000000104",
};

let db: TestDatabase;
type Scope = { scope: "own" | "all" | null; user?: string; sweep?: boolean };
async function as<T>(role: DbRole, s: Scope, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    await c.query("BEGIN");
    if (s.scope)
      await c.query(
        "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', $2, true), set_config('lume.calendar_sweep', $3, true)",
        [s.user ?? U.rep, s.scope, s.sweep ? "on" : ""],
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
const ids = async (role: DbRole, s: Scope, sql: string) =>
  (await as(role, s, async (c) => (await c.query<{ id: string }>(sql)).rows.map((r) => r.id))).sort();

const connection = (c: pg.Client, id: string, user: string) =>
  c.query(
    "INSERT INTO calendar_connections (id, user_id, google_email, grant_enc) VALUES ($1, $2, $3, '\\x00')",
    [id, user, `${user.slice(-2)}@calendar.test`],
  );
const meeting = (c: pg.Client, id: string, owner: string, lead: string | null, conn: string | null) =>
  c.query(
    `INSERT INTO meetings (id, lead_id, owner_id, connection_id, source, external_id, calendar_id, title, starts_at, ends_at, matched_by)
     VALUES ($1, $2, $3, $4, 'google', $6, 'primary', 'Discovery call', now(), now() + interval '30 minutes', $5)`,
    [id, lead, owner, conn, lead ? "attendee" : "title", `event-${id}`],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  await as("lume_owner", { scope: "all" }, async (c) => {
    for (const id of [U.rep, U.other])
      await c.query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')", [
        id,
        `${id.slice(-2)}@x.com`,
        `Person ${id.slice(-2)}`,
      ]);
    await c.query(
      "INSERT INTO pipelines (id, name, is_default) VALUES ('0190e0c0-0000-7000-8000-0000000000f1', 'P', true)",
    );
    await c.query(
      "INSERT INTO stages (id, pipeline_id, name, kind, position) VALUES ('0190e0c0-0000-7000-8000-0000000000f2', '0190e0c0-0000-7000-8000-0000000000f1', 'New', 'open', 0)",
    );
    for (const [id, owner] of [
      [L.rep, U.rep],
      [L.other, U.other],
    ])
      await c.query(
        "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name) VALUES ($1, '0190e0c0-0000-7000-8000-0000000000f1', '0190e0c0-0000-7000-8000-0000000000f2', $2, 'Lead')",
        [id, owner],
      );
  });
  // LUME's sync writes as the calendar's person, seeing every lead (as a sheet's run-as).
  await as("lume_app", { scope: "all", user: U.rep }, async (c) => {
    await connection(c, C.rep, U.rep);
    await meeting(c, M.repLead, U.rep, L.rep, C.rep);
    await meeting(c, M.repUnlinked, U.rep, null, C.rep);
  });
  await as("lume_app", { scope: "all", user: U.other }, async (c) => {
    await connection(c, C.other, U.other);
    await meeting(c, M.otherLead, U.other, L.other, C.other);
    await meeting(c, M.otherUnlinked, U.other, null, C.other);
  });
});
afterAll(async () => db.drop());

describe("meetings (5A): row-level security", () => {
  it("a meeting with a lead is seen exactly when its lead is", async () => {
    expect(
      await ids("lume_app", { scope: "own" }, "SELECT id FROM meetings WHERE lead_id IS NOT NULL"),
    ).toEqual([M.repLead]);
    expect(
      await ids("lume_app", { scope: "all" }, "SELECT id FROM meetings WHERE lead_id IS NOT NULL"),
    ).toEqual([M.repLead, M.otherLead].sort());
  });

  it("an unlinked meeting is its owner's alone, even to someone who sees every lead", async () => {
    expect(await ids("lume_app", { scope: "all" }, "SELECT id FROM meetings WHERE lead_id IS NULL")).toEqual([
      M.repUnlinked,
    ]);
    expect(
      await ids("lume_app", { scope: "own", user: U.other }, "SELECT id FROM meetings WHERE lead_id IS NULL"),
    ).toEqual([M.otherUnlinked]);
  });

  it("fails closed: no request scope, no meetings", async () => {
    expect(await ids("lume_app", { scope: null }, "SELECT id FROM meetings")).toEqual([]);
  });

  it("no one creates a meeting in someone else's name, or links one to a lead they can't see", async () => {
    await expect(
      as("lume_app", { scope: "all" }, (c) =>
        meeting(c, "0190e0c0-0000-7000-8000-000000000201", U.other, null, null),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as("lume_app", { scope: "own" }, (c) =>
        meeting(c, "0190e0c0-0000-7000-8000-000000000202", U.rep, L.other, null),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("attaching an unlinked meeting to a lead they can't see is refused", async () => {
    const n = await as(
      "lume_app",
      { scope: "own" },
      async (c) =>
        (await c.query("UPDATE meetings SET lead_id = $1 WHERE id = $2", [L.other, M.repUnlinked])).rowCount,
    ).catch((e: Error) => e.message);
    expect(String(n)).toMatch(/row-level security/);
  });

  it("the sweep (Log outcome, Task 6) reads every meeting; the worker reads none; backups read all", async () => {
    expect(await ids("lume_app", { scope: "all", sweep: true }, "SELECT id FROM meetings")).toEqual(
      Object.values(M).sort(),
    );
    await expect(
      as("lume_worker", { scope: "all" }, (c) => c.query("SELECT id FROM meetings")),
    ).rejects.toThrow(/permission denied/);
    expect(await ids("lume_readonly_backup", { scope: null }, "SELECT id FROM meetings")).toEqual(
      Object.values(M).sort(),
    );
  });

  it("one meeting per event per person", async () => {
    await expect(
      as("lume_app", { scope: "all" }, (c) =>
        c.query(
          `INSERT INTO meetings (id, owner_id, source, external_id, title, starts_at, ends_at, matched_by)
           VALUES (gen_random_uuid(), $1, 'google', $2, 'Again', now(), now(), 'title')`,
          [U.rep, `event-${M.repLead}`],
        ),
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe("calendar connections (5A): row-level security", () => {
  it("a person sees their own connection only, whatever their lead scope", async () => {
    expect(await ids("lume_app", { scope: "all" }, "SELECT id FROM calendar_connections")).toEqual([C.rep]);
  });

  it("the scheduler's sweep lists every connection, and can't write one", async () => {
    expect(
      await ids("lume_app", { scope: "all", sweep: true }, "SELECT id FROM calendar_connections"),
    ).toEqual([C.rep, C.other].sort());
    const changed = await as(
      "lume_app",
      { scope: "all", sweep: true },
      async (c) =>
        (await c.query("UPDATE calendar_connections SET failures = 9 WHERE id = $1", [C.other])).rowCount,
    );
    expect(changed).toBe(0);
  });

  it("one connection per person", async () => {
    await expect(
      as("lume_app", { scope: "all" }, (c) => connection(c, "0190e0c0-0000-7000-8000-0000000000e9", U.rep)),
    ).rejects.toThrow(/duplicate key/);
  });

  it("the worker can't read a grant", async () => {
    await expect(
      as("lume_worker", { scope: "all" }, (c) => c.query("SELECT grant_enc FROM calendar_connections")),
    ).rejects.toThrow(/permission denied/);
  });

  it("disconnecting takes every meeting the connection brought", async () => {
    await as("lume_app", { scope: "all", user: U.other }, (c) =>
      c.query("DELETE FROM calendar_connections WHERE id = $1", [C.other]),
    );
    expect(await ids("lume_readonly_backup", { scope: null }, "SELECT id FROM meetings")).toEqual(
      [M.repLead, M.repUnlinked].sort(),
    );
  });
});

describe("settings.calendar (5A)", () => {
  it("defaults to: an attendee who is a lead makes a meeting; no title words; no calendars", async () => {
    const row = await as("lume_owner", { scope: "all" }, async (c) => {
      await c.query(
        "INSERT INTO settings (id, business_name, timezone, currency, default_country_iso, industry_preset) VALUES (1, 'B', 'UTC', 'USD', 'US', 'generic')",
      );
      return (await c.query<{ calendar: unknown }>("SELECT calendar FROM settings")).rows[0];
    });
    expect(row?.calendar).toEqual({ rules: { attendeeIsLead: true, titleWords: [], calendarIds: [] } });
  });
});
