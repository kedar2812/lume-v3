import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

/**
 * Phase 7A Task 4 (0048): search through its own table. Under row-level security Postgres can't use a LIKE index
 * on leads (texticlike isn't leakproof), so search reads lead_search: a mirror the app can't touch, read only
 * through lume_lead_search, which applies the leads policies' rule itself (Review Focus 1, 3).
 */
const U = {
  rep: "0190e0c0-0000-7000-8000-0000000008a1",
  mate: "0190e0c0-0000-7000-8000-0000000008a2",
  other: "0190e0c0-0000-7000-8000-0000000008a3",
};
const P = "0190e0c0-0000-7000-8000-0000000008f1";
const S = "0190e0c0-0000-7000-8000-0000000008f2";
const L = {
  rep: "0190e0c0-0000-7000-8000-0000000008b1",
  mate: "0190e0c0-0000-7000-8000-0000000008b2",
  other: "0190e0c0-0000-7000-8000-0000000008b3",
  none: "0190e0c0-0000-7000-8000-0000000008b4",
};

let db: TestDatabase;
type Ctx = { scope?: string; user?: string; team?: string; handoff?: string };
async function as<T>(role: DbRole, ctx: Ctx, fn: (c: pg.Client) => Promise<T>, commit = false): Promise<T> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    await c.query("BEGIN");
    for (const [k, name] of [
      ["scope", "lume.lead_scope"],
      ["user", "lume.user_id"],
      ["team", "lume.team_member_ids"],
      ["handoff", "lume.handoff_lead"],
    ] as const)
      if (ctx[k] !== undefined) await c.query("SELECT set_config($1, $2, true)", [name, ctx[k]]);
    const out = await fn(c);
    await c.query(commit ? "COMMIT" : "ROLLBACK");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
const all: Ctx = { scope: "all", user: U.rep };
/** lume_lead_search(name_like, prefix_like, email_like, instagram_like, digits_like, max_rows), as the app calls it. */
const search = (
  ctx: Ctx,
  a: {
    name?: string | null;
    prefix?: string | null;
    email?: string | null;
    instagram?: string | null;
    digits?: string | null;
    max?: number;
  },
) =>
  as("lume_app", ctx, async (c) =>
    (
      await c.query<{ id: string }>("SELECT lume_lead_search($1, $2, $3, $4, $5, $6) AS id", [
        a.name ?? null,
        a.prefix ?? null,
        a.email ?? null,
        a.instagram ?? null,
        a.digits ?? null,
        a.max ?? 1000,
      ])
    ).rows
      .map((r) => r.id)
      .sort(),
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  await as(
    "lume_owner",
    all,
    async (c) => {
      for (const [id, email] of [
        [U.rep, "rep@example.test"],
        [U.mate, "mate@example.test"],
        [U.other, "other@example.test"],
      ])
        await c.query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')", [
          id,
          email,
          email,
        ]);
      await c.query("INSERT INTO pipelines (id, name, is_default) VALUES ($1, 'P', true)", [P]);
      await c.query(
        "INSERT INTO stages (id, pipeline_id, name, kind, position) VALUES ($1, $2, 'New', 'open', 0)",
        [S, P],
      );
      for (const [id, owner, name, email, phone, insta] of [
        [L.rep, U.rep, "Lead Aisha Khan", "aisha@leads.test", "+971501110001", "aisha.k"],
        [L.mate, U.mate, "Lead Omar Saleh", "omar@leads.test", "+971501110002", null],
        [L.other, U.other, "Lead Noor Faris", "noor@leads.test", "+971501110003", "noorf"],
        [L.none, null, "Lead Unowned", null, null, null],
      ] as const)
        await c.query(
          `INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, email, phone_e164, phone_status, instagram_handle)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, P, S, owner, name, email, phone, phone ? "valid" : "missing", insta],
        );
    },
    true,
  );
});
afterAll(async () => db.drop());

describe("0048: lead_search, the table search reads (Review Focus 1, 3)", { timeout: 60_000 }, () => {
  it("the app can't read or write it: only lume_lead_search reads it", async () => {
    await expect(as("lume_app", all, (c) => c.query("SELECT * FROM lead_search"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(as("lume_app", all, (c) => c.query("DELETE FROM lead_search"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(as("lume_worker", all, (c) => c.query("SELECT * FROM lead_search"))).rejects.toThrow(
      /permission denied/,
    );
    // Backups still read it (pg_dump), and restore rebuilds it.
    const n = await as(
      "lume_readonly_backup",
      {},
      async (c) => (await c.query("SELECT count(*)::int AS n FROM lead_search")).rows[0].n,
    );
    expect(n).toBe(4);
  });

  it("finds by name inside, by a name's start, by email or Instagram, and by phone digits; each branch alone", async () => {
    expect(await search(all, { name: "%omar%" })).toEqual([L.mate]);
    expect(await search(all, { prefix: "lead n%" })).toEqual([L.other]);
    expect(await search(all, { instagram: "%noorf%" })).toEqual([L.other]);
    expect(await search(all, { email: "%aisha@%" })).toEqual([L.rep]);
    // Each contact branch is its own: a hidden Instagram is never matched through the email pattern, and back.
    expect(await search(all, { email: "%noorf%" })).toEqual([]);
    expect(await search(all, { instagram: "%aisha@%" })).toEqual([]);
    expect(await search(all, { digits: "%1110002%" })).toEqual([L.mate]);
    expect(
      await search(all, { name: "%zzyzx%", email: "%zzyzx%", instagram: "%zzyzx%", digits: "%9999%" }),
    ).toEqual([]);
    expect(await search(all, {})).toEqual([]); // nothing asked, nothing found
    // A name match isn't a contact match: the app decides which branches a person may use.
    expect(await search(all, { name: "%aisha@%" })).toEqual([]);
  });

  it("keeps at most max_rows (the cap), and the app asks for one more to know there were more", async () => {
    expect(await search(all, { name: "%lead%", max: 2 })).toHaveLength(2);
    expect(await search(all, { name: "%lead%", max: 5 })).toHaveLength(4);
  });

  it("sees exactly the leads the policies show, in every context (the oracle is leads' own RLS)", async () => {
    const contexts: Ctx[] = [
      {},
      { scope: "all" },
      { scope: "all", user: "" },
      { scope: "own", user: U.rep },
      { scope: "own", user: "" },
      { scope: "team", user: U.rep, team: "{}" },
      { scope: "team", user: U.rep, team: `{${U.mate}}` },
      { scope: "team", user: "", team: `{${U.mate}}` },
      { scope: "bogus", user: U.rep },
      { scope: "", user: U.rep },
      // A hand-off is a read allowance for one lead being handed away, never a way into search.
      { scope: "own", user: U.rep, handoff: L.other },
    ];
    for (const ctx of contexts) {
      const visible = await as("lume_app", ctx, async (c) =>
        (
          await c.query<{ id: string }>(
            "SELECT id FROM leads WHERE name ILIKE '%lead%' AND id IS DISTINCT FROM NULLIF(current_setting('lume.handoff_lead', true), '')::uuid ORDER BY id",
          )
        ).rows.map((r) => r.id),
      );
      expect(await search(ctx, { name: "%lead%" }), JSON.stringify(ctx)).toEqual(visible.sort());
    }
  });

  it("follows every change: a rename, a new email or phone, a new owner, a soft delete and its undo, a new lead", async () => {
    const as_all = (sql: string, params: unknown[]) =>
      as("lume_owner", all, (c) => c.query(sql, params), true);
    await as_all(
      "UPDATE leads SET name = 'Lead Aisha Rahman', email = 'a.rahman@leads.test', phone_e164 = '+971509990001' WHERE id = $1",
      [L.rep],
    );
    expect(await search(all, { name: "%rahman%" })).toEqual([L.rep]);
    expect(await search(all, { name: "%khan%" })).toEqual([]);
    expect(await search(all, { email: "%a.rahman@%" })).toEqual([L.rep]);
    expect(await search(all, { digits: "%9990001%" })).toEqual([L.rep]);
    // A new owner: the rep no longer finds it, its new owner does.
    await as_all("UPDATE leads SET owner_id = $2 WHERE id = $1", [L.rep, U.mate]);
    expect(await search({ scope: "own", user: U.rep }, { name: "%rahman%" })).toEqual([]);
    expect(await search({ scope: "own", user: U.mate }, { name: "%rahman%" })).toEqual([L.rep]);
    // Deleted leads aren't found; restored, they are again.
    await as_all("UPDATE leads SET deleted_at = now() WHERE id = $1", [L.rep]);
    expect(await search(all, { name: "%rahman%" })).toEqual([]);
    await as_all("UPDATE leads SET deleted_at = NULL WHERE id = $1", [L.rep]);
    expect(await search(all, { name: "%rahman%" })).toEqual([L.rep]);
    // A lead made by the app, as a rep, is found at once.
    const id = "0190e0c0-0000-7000-8000-0000000008b9";
    await as(
      "lume_app",
      { scope: "own", user: U.rep },
      (c) =>
        c.query(
          "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name) VALUES ($1, $2, $3, $4, 'Lead Fresh One')",
          [id, P, S, U.rep],
        ),
      true,
    );
    expect(await search({ scope: "own", user: U.rep }, { prefix: "lead fresh%" })).toEqual([id]);
  });
});
