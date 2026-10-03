import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

/** Phase 7A Task 3: each lead carries its tags (tag_ids), always equal to lead_tags (Review Focus 2). */
const U = { rep: "0190e0c0-0000-7000-8000-0000000007a1", other: "0190e0c0-0000-7000-8000-0000000007a2" };
const P = "0190e0c0-0000-7000-8000-0000000007f1";
const S = "0190e0c0-0000-7000-8000-0000000007f2";
const T = [
  "0190e0c0-0000-7000-8000-0000000007c1",
  "0190e0c0-0000-7000-8000-0000000007c2",
  "0190e0c0-0000-7000-8000-0000000007c3",
] as const;
const [A, B, C] = T;
let n = 0;
const leadId = () => `0190e0c0-0000-7000-8000-${String(0x7d0000 + ++n).padStart(12, "0")}`;

let db: TestDatabase;
let before: string;

type Ctx = { scope?: string; user?: string };
async function as<T>(role: DbRole, ctx: Ctx, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    await c.query("BEGIN");
    if (ctx.scope !== undefined) await c.query("SELECT set_config('lume.lead_scope', $1, true)", [ctx.scope]);
    if (ctx.user !== undefined) await c.query("SELECT set_config('lume.user_id', $1, true)", [ctx.user]);
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
const all: Ctx = { scope: "all", user: U.rep };
const tagIds = async (id: string) =>
  as(
    "lume_owner",
    all,
    async (c) => (await c.query("SELECT tag_ids FROM leads WHERE id = $1", [id])).rows[0].tag_ids as string[],
  );
const truth = async (id: string) =>
  as("lume_owner", all, async (c) =>
    (await c.query("SELECT tag_id FROM lead_tags WHERE lead_id = $1 ORDER BY tag_id", [id])).rows.map(
      (r) => r.tag_id as string,
    ),
  );
async function newLead(owner: string | null): Promise<string> {
  const id = leadId();
  await as("lume_owner", all, (c) =>
    c.query("INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name) VALUES ($1, $2, $3, $4, 'Lead')", [
      id,
      P,
      S,
      owner,
    ]),
  );
  return id;
}

let backfilled: string;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  // An install as it stood before 0047, with a tagged lead, then the update.
  before = await mkdtemp(path.join(tmpdir(), "mig-0046-"));
  for (const f of await readdir(MIGRATIONS_DIR_DEFAULT))
    if (/^\d{4}_/.test(f) && f < "0047")
      await copyFile(path.join(MIGRATIONS_DIR_DEFAULT, f), path.join(before, f));
  await migrate(db.url("lume_owner"), before);
  await as("lume_owner", all, async (c) => {
    for (const [id, email] of [
      [U.rep, "rep@example.test"],
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
    for (const [i, t] of T.entries())
      await c.query("INSERT INTO tags (id, label) VALUES ($1, $2)", [t, `Tag ${i}`]);
  });
  backfilled = leadId();
  await as("lume_owner", all, async (c) => {
    await c.query(
      "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name) VALUES ($1, $2, $3, $4, 'Old')",
      [backfilled, P, S, U.rep],
    );
    await c.query("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2), ($1, $3)", [backfilled, C, A]);
  });
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
});
afterAll(async () => {
  await db.drop();
  await rm(before, { recursive: true, force: true });
});

describe("0047: tag_ids follows lead_tags (Review Focus 2)", () => {
  it("the update fills tag_ids for leads that already had tags, sorted", async () => {
    expect(await tagIds(backfilled)).toEqual([A, C].sort());
  });

  it("adding, removing one, removing all: tag_ids always equals lead_tags", async () => {
    const id = await newLead(U.rep);
    expect(await tagIds(id)).toEqual([]);
    await as("lume_app", { scope: "own", user: U.rep }, (c) =>
      c.query("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2), ($1, $3)", [id, B, A]),
    );
    expect(await tagIds(id)).toEqual(await truth(id));
    expect(await tagIds(id)).toEqual([A, B].sort());
    await as("lume_app", { scope: "own", user: U.rep }, (c) =>
      c.query("DELETE FROM lead_tags WHERE lead_id = $1 AND tag_id = $2", [id, A]),
    );
    expect(await tagIds(id)).toEqual([B]);
    await as("lume_app", { scope: "own", user: U.rep }, (c) =>
      c.query("DELETE FROM lead_tags WHERE lead_id = $1", [id]),
    );
    expect(await tagIds(id)).toEqual([]);
  });

  it("many leads in one statement: each lead's tag_ids is right", async () => {
    const ids = [await newLead(U.rep), await newLead(U.rep), await newLead(U.rep)];
    await as("lume_app", { scope: "own", user: U.rep }, (c) =>
      c.query(
        "INSERT INTO lead_tags (lead_id, tag_id) SELECT l, t FROM unnest($1::uuid[]) l, unnest($2::uuid[]) t",
        [ids, [A, C]],
      ),
    );
    for (const id of ids) expect(await tagIds(id)).toEqual([A, C].sort());
    await as("lume_app", { scope: "own", user: U.rep }, (c) =>
      c.query("DELETE FROM lead_tags WHERE lead_id = ANY($1) AND tag_id = $2", [ids.slice(0, 2), C]),
    );
    expect(await tagIds(ids[0]!)).toEqual([A]);
    expect(await tagIds(ids[2]!)).toEqual([A, C].sort());
  });

  it("a tag deleted removes itself from every lead, even leads the deleter can't see, even with no user set", async () => {
    const theirs = await newLead(U.other);
    const unassigned = await newLead(null);
    await as("lume_owner", all, (c) =>
      c.query("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $3), ($1, $4), ($2, $3)", [
        theirs,
        unassigned,
        B,
        C,
      ]),
    );
    const tmp = "0190e0c0-0000-7000-8000-0000000007c9";
    await as("lume_owner", all, async (c) => {
      await c.query("INSERT INTO tags (id, label) VALUES ($1, 'Temp')", [tmp]);
      await c.query("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2), ($3, $2)", [
        theirs,
        tmp,
        unassigned,
      ]);
    });
    // A rep (own scope) deletes a tag: the cascade reaches leads they can't see.
    await as("lume_app", { scope: "own", user: U.rep }, (c) =>
      c.query("DELETE FROM tags WHERE id = $1", [tmp]),
    );
    expect(await tagIds(theirs)).toEqual([B, C].sort());
    expect(await tagIds(unassigned)).toEqual([B]);
    // And from a session with no settings at all.
    await as("lume_owner", {}, (c) => c.query("DELETE FROM tags WHERE id = $1", [C]));
    expect(await tagIds(theirs)).toEqual([B]);
    expect(await tagIds(theirs)).toEqual(await truth(theirs));
  });

  it("the caller's scope is put back after LUME's bookkeeping: a rep still sees only their own leads", async () => {
    const mine = await newLead(U.rep);
    const seen = await as("lume_app", { scope: "own", user: U.rep }, async (c) => {
      await c.query("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [mine, A]);
      return {
        scope: (await c.query("SELECT current_setting('lume.lead_scope', true) AS s")).rows[0].s,
        user: (await c.query("SELECT current_setting('lume.user_id', true) AS s")).rows[0].s,
        others: (
          await c.query("SELECT count(*)::int AS n FROM leads WHERE owner_id <> $1 OR owner_id IS NULL", [
            U.rep,
          ])
        ).rows[0].n,
      };
    });
    expect(seen).toEqual({ scope: "own", user: U.rep, others: 0 });
  });

  it("tag_ids can't be written directly: only lead_tags moves it, so nothing can make it drift", async () => {
    const id = await newLead(U.rep);
    await expect(
      as("lume_app", { scope: "own", user: U.rep }, (c) =>
        c.query("UPDATE leads SET tag_ids = $2 WHERE id = $1", [id, [A]]),
      ),
    ).rejects.toThrow(/tag_ids follows lead_tags/);
    await expect(
      as("lume_owner", all, (c) =>
        c.query(
          "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, tag_ids) VALUES ($1, $2, $3, $4, 'X', $5)",
          [leadId(), P, S, U.rep, [A]],
        ),
      ),
    ).rejects.toThrow(/tag_ids follows lead_tags/);
    // Every other column still updates as before, and tag_ids is left alone.
    await as("lume_app", { scope: "own", user: U.rep }, (c) =>
      c.query("UPDATE leads SET name = 'Renamed' WHERE id = $1", [id]),
    );
    expect(await tagIds(id)).toEqual([]);
  });

  it("two people tagging the same lead at once: both tags land (no lost update)", async () => {
    const id = await newLead(U.rep);
    const one = new pg.Client({ connectionString: db.url("lume_app") });
    const two = new pg.Client({ connectionString: db.url("lume_app") });
    await one.connect();
    await two.connect();
    try {
      for (const c of [one, two]) {
        await c.query("BEGIN");
        await c.query(
          "SELECT set_config('lume.lead_scope', 'own', true), set_config('lume.user_id', $1, true)",
          [U.rep],
        );
      }
      await one.query("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [id, A]);
      // The second waits on the first's lock on the lead, then counts the first's tag once it commits.
      const second = two.query("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [id, B]);
      await new Promise((r) => setTimeout(r, 300));
      await one.query("COMMIT");
      await second;
      await two.query("COMMIT");
    } finally {
      await one.end();
      await two.end();
    }
    expect(await tagIds(id)).toEqual([A, B].sort());
  });
});
