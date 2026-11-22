import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

/**
 * Instagram's tables (migration 0118; plan 1A Task 3): each delivery once, one conversation per person and account,
 * one private reply per comment, and row-level security alone (raw SQL as lume_app) keeping a rep to their own leads'
 * conversations while Not a lead yet stays with the account's owner and whoever sees every lead.
 */
const U = {
  rep: "0190e0c0-0000-7000-8000-00000000010a",
  mate: "0190e0c0-0000-7000-8000-00000000010b",
  owner: "0190e0c0-0000-7000-8000-00000000010c",
};
const L = { rep: "0190e0c0-0000-7000-8000-0000000001a1", mate: "0190e0c0-0000-7000-8000-0000000001b1" };
const ACCT = "0190e0c0-0000-7000-8000-0000000001c1";
const T = {
  rep: "0190e0c0-0000-7000-8000-0000000001d1",
  mate: "0190e0c0-0000-7000-8000-0000000001d2",
  stranger: "0190e0c0-0000-7000-8000-0000000001d3",
};

let db: TestDatabase;
type Scope = { scope: "own" | "team" | "all"; user: string };
async function as<T>(role: DbRole, s: Scope | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: db.url(role) });
  await c.connect();
  try {
    await c.query("BEGIN");
    if (s)
      await c.query(
        "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', $2, true), set_config('lume.team_member_ids', '{}', true)",
        [s.user, s.scope],
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
const asOwner = <T>(fn: (c: pg.Client) => Promise<T>) => as("lume_owner", { scope: "all", user: U.rep }, fn);

beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  await asOwner(async (c) => {
    for (const [id, email] of Object.entries(U).map(([k, v]) => [v, `${k}@x.test`]))
      await c.query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')", [
        id,
        email,
        email,
      ]);
    await c.query(
      "INSERT INTO pipelines (id, name, is_default) VALUES ('0190e0c0-0000-7000-8000-0000000001f1', 'P', true)",
    );
    await c.query(
      "INSERT INTO stages (id, pipeline_id, name, kind, position) VALUES ('0190e0c0-0000-7000-8000-0000000001f2', '0190e0c0-0000-7000-8000-0000000001f1', 'New', 'open', 0)",
    );
    for (const [id, owner] of [
      [L.rep, U.rep],
      [L.mate, U.mate],
    ])
      await c.query(
        "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_status) VALUES ($1, '0190e0c0-0000-7000-8000-0000000001f1', '0190e0c0-0000-7000-8000-0000000001f2', $2, 'Lead', 'missing')",
        [id, owner],
      );
    await c.query(
      "INSERT INTO instagram_accounts (id, ig_user_id, username, owner_user_id, run_as, token_enc, status) VALUES ($1, '17841400000000001', 'harbour.studio', $2, $2, '\\x00'::bytea, 'active')",
      [ACCT, U.owner],
    );
    for (const [id, lead, igsid] of [
      [T.rep, L.rep, "1001"],
      [T.mate, L.mate, "1002"],
      [T.stranger, null, "1003"],
    ])
      await c.query(
        "INSERT INTO instagram_threads (id, account_id, igsid, lead_id) VALUES ($1, $2, $3, $4)",
        [id, ACCT, igsid, lead],
      );
  });
});
afterAll(async () => db.drop());

const threadsSeen = (s: Scope) =>
  as("lume_app", s, async (c) =>
    (await c.query<{ id: string }>("SELECT id FROM instagram_threads ORDER BY id")).rows.map((r) => r.id),
  );

describe("instagram tables", () => {
  it("keep each delivery once per account and key", async () => {
    await as("lume_app", null, async (c) => {
      const ins = () =>
        c.query(
          "INSERT INTO instagram_events (account_ig_id, event_key, kind, status) VALUES ('17841400000000001', 'm:aWdfMID1', 'message', 'queued') ON CONFLICT DO NOTHING RETURNING id",
        );
      expect((await ins()).rowCount).toBe(1);
      expect((await ins()).rowCount).toBe(0);
    });
  });

  it("hold one conversation per person and account", async () => {
    await expect(
      asOwner((c) =>
        c.query(
          "INSERT INTO instagram_threads (id, account_id, igsid) VALUES (gen_random_uuid(), $1, '1001')",
          [ACCT],
        ),
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("refuse a second private reply to one comment while the first stands", async () => {
    const out = (status: string, key: string) =>
      asOwner((c) =>
        c.query(
          `INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, comment_id, text, status)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'private_reply', 'C1', 'Here you go', $6)`,
          [T.rep, L.rep, ACCT, U.rep, key, status],
        ),
      );
    await out("failed", "0190e0c0-0000-7000-8000-0000000001e0");
    await out("queued", "0190e0c0-0000-7000-8000-0000000001e1");
    await expect(out("queued", "0190e0c0-0000-7000-8000-0000000001e2")).rejects.toThrow(/duplicate key/);
  });

  it("refuse a message over 1,000 bytes and a double send of one key", async () => {
    const send = (text: string, key: string) =>
      asOwner((c) =>
        c.query(
          `INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, text, status)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'dm', $6, 'queued')`,
          [T.rep, L.rep, ACCT, U.rep, key, text],
        ),
      );
    await expect(send("😀".repeat(251), "0190e0c0-0000-7000-8000-0000000001e3")).rejects.toThrow(/check/);
    await send("😀".repeat(250), "0190e0c0-0000-7000-8000-0000000001e4");
    await expect(send("again", "0190e0c0-0000-7000-8000-0000000001e4")).rejects.toThrow(/duplicate key/);
  });

  it("refuse an account id that isn't Meta's", async () => {
    await expect(
      asOwner((c) =>
        c.query(
          "INSERT INTO instagram_accounts (id, ig_user_id, username, run_as, status) VALUES (gen_random_uuid(), 'abc', 'x', $1, 'disconnected')",
          [U.rep],
        ),
      ),
    ).rejects.toThrow(/check/);
  });
});

describe("row-level security alone", () => {
  it("a rep sees only their own leads' conversations, never Not a lead yet", async () => {
    expect(await threadsSeen({ scope: "own", user: U.rep })).toEqual([T.rep]);
  });
  it("the account's owner sees Not a lead yet and their own leads'", async () => {
    expect(await threadsSeen({ scope: "own", user: U.owner })).toEqual([T.stranger]);
  });
  it("whoever sees every lead sees every conversation", async () => {
    expect(await threadsSeen({ scope: "all", user: U.rep })).toEqual([T.rep, T.mate, T.stranger].sort());
  });
  it("a rep can't move a conversation onto a lead they can't see", async () => {
    await expect(
      as("lume_app", { scope: "own", user: U.rep }, (c) =>
        c.query("UPDATE instagram_threads SET lead_id = $1 WHERE id = $2", [L.mate, T.rep]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it("a rep sees only their own leads' messages and media", async () => {
    await asOwner(async (c) => {
      for (const [t, l, key] of [
        [T.rep, L.rep, "0190e0c0-0000-7000-8000-0000000002e1"],
        [T.mate, L.mate, "0190e0c0-0000-7000-8000-0000000002e2"],
      ]) {
        await c.query(
          `INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, text, status)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'dm', 'hi', 'sent')`,
          [t, l, ACCT, U.rep, key],
        );
        await c.query(
          `INSERT INTO instagram_media (id, account_id, thread_id, lead_id, mid, url, kind, status)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'https://x.test/a', 'image', 'waiting')`,
          [ACCT, t, l, `mid-${key}`],
        );
      }
    });
    const seen = await as("lume_app", { scope: "own", user: U.rep }, async (c) => ({
      out: (await c.query<{ lead_id: string }>("SELECT DISTINCT lead_id FROM instagram_outbox")).rows,
      media: (await c.query<{ lead_id: string }>("SELECT DISTINCT lead_id FROM instagram_media")).rows,
    }));
    expect(seen.out.map((r) => r.lead_id)).toEqual([L.rep]);
    expect(seen.media.map((r) => r.lead_id)).toEqual([L.rep]);
  });
  it("comments: the account's owner sees them; a rep only those that led to their own conversation", async () => {
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO instagram_comments (id, account_id, comment_id, from_igsid, at, thread_id)
         VALUES (gen_random_uuid(), $1, 'C-rep', '1001', now(), $2), (gen_random_uuid(), $1, 'C-free', '1009', now(), NULL)`,
        [ACCT, T.rep],
      );
    });
    const ids = (s: Scope) =>
      as("lume_app", s, async (c) =>
        (
          await c.query<{ comment_id: string }>("SELECT comment_id FROM instagram_comments ORDER BY 1")
        ).rows.map((r) => r.comment_id),
      );
    expect(await ids({ scope: "own", user: U.rep })).toEqual(["C-rep"]);
    expect(await ids({ scope: "own", user: U.mate })).toEqual([]);
    expect(await ids({ scope: "own", user: U.owner })).toEqual(["C-free", "C-rep"]);
  });
  it("the worker can't read any of it", async () => {
    await expect(as("lume_worker", null, (c) => c.query("SELECT 1 FROM instagram_threads"))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("live notices", () => {
  it("say the lead and what happened, never the words", async () => {
    const c = new pg.Client({ connectionString: db.url("lume_owner") });
    await c.connect();
    const got: string[] = [];
    c.on("notification", (n) => got.push(n.payload ?? ""));
    await c.query("LISTEN lume_instagram");
    await asOwner((x) =>
      x.query(
        "INSERT INTO activities (id, lead_id, type, payload) VALUES (gen_random_uuid(), $1, 'instagram_received', $2)",
        [L.rep, JSON.stringify({ text: "my secret words" })],
      ),
    );
    await new Promise((r) => setTimeout(r, 200));
    await c.end();
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0]!)).toEqual({ lead: L.rep, kind: "in", owner: U.rep });
    expect(got[0]).not.toContain("secret");
  });
});

describe("files", () => {
  it("count Instagram's media as references, so the sweep never removes a file in use", async () => {
    const sha = "a".repeat(64);
    const refs = () =>
      asOwner(
        async (c) =>
          (await c.query<{ refs: number }>("SELECT refs FROM whatsapp_files WHERE sha256 = $1", [sha]))
            .rows[0]!.refs,
      );
    await asOwner((c) => c.query("INSERT INTO whatsapp_files (sha256, size) VALUES ($1, 10)", [sha]));
    const id = "0190e0c0-0000-7000-8000-0000000003a1";
    await asOwner((c) =>
      c.query(
        `INSERT INTO instagram_media (id, account_id, thread_id, lead_id, mid, url, kind, status, sha256)
         VALUES ($1, $2, $3, $4, 'mid-file', 'https://x.test/a', 'image', 'ready', $5)`,
        [id, ACCT, T.rep, L.rep, sha],
      ),
    );
    expect(await refs()).toBe(1);
    await asOwner((c) => c.query("DELETE FROM instagram_media WHERE id = $1", [id]));
    expect(await refs()).toBe(0);
  });
});
