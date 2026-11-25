import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type DbRole, type TestDatabase } from "./testing";

/**
 * Team Chat's tables (migration 0130; plan 2026-11-24-team-chat-2a, Task 1), by row-level security alone (raw SQL as
 * lume_app): a channel is read only by its members (owner, 2026-11-24), a lead's thread by whoever may see the lead, and
 * a channel's groups keep their people in as teams, roles and people change.
 */
const U = {
  rep: "0190e0c0-0000-7000-8000-00000000020a",
  mate: "0190e0c0-0000-7000-8000-00000000020b",
  boss: "0190e0c0-0000-7000-8000-00000000020c",
};
const LEAD = "0190e0c0-0000-7000-8000-0000000002a1";
const SALES = "0190e0c0-0000-7000-8000-0000000002b1";
const TEAM = "0190e0c0-0000-7000-8000-0000000002c1";
const ROLE = "0190e0c0-0000-7000-8000-0000000002d1";
const PIPE = "0190e0c0-0000-7000-8000-0000000002f1";
const STAGE = "0190e0c0-0000-7000-8000-0000000002f2";

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
const owner = <T>(fn: (c: pg.Client) => Promise<T>) => as("lume_owner", { scope: "all", user: U.boss }, fn);
const app = <T>(user: string, fn: (c: pg.Client) => Promise<T>, scope: Scope["scope"] = "own") =>
  as("lume_app", { scope, user }, fn);
const channelsOf = (user: string) =>
  app(user, async (c) =>
    (
      await c.query<{ name: string }>(
        "SELECT name FROM chat_conversations WHERE kind = 'channel' ORDER BY name",
      )
    ).rows.map((r) => r.name),
  );
// By the owner, who isn't in every channel: the channel's id as someone in it reads it, then its members.
const membersOf = async (channel: string) => {
  const id = await app(
    U.rep,
    async (c) =>
      (await c.query<{ id: string }>("SELECT id FROM chat_conversations WHERE name = $1", [channel])).rows[0]!
        .id,
  );
  return owner(
    async (c) =>
      (
        await c.query<{ user_id: string; via: string }>(
          "SELECT user_id, via FROM chat_members WHERE conversation_id = $1 ORDER BY user_id",
          [id],
        )
      ).rows,
  );
};

beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
  await owner(async (c) => {
    for (const [k, id] of Object.entries(U))
      await c.query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')", [
        id,
        `${k}@x.test`,
        k,
      ]);
    await c.query("INSERT INTO pipelines (id, name, is_default) VALUES ($1, 'P', true)", [PIPE]);
    await c.query(
      "INSERT INTO stages (id, pipeline_id, name, kind, position) VALUES ($1, $2, 'New', 'open', 0)",
      [STAGE, PIPE],
    );
    await c.query(
      "INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_status) VALUES ($1, $2, $3, $4, 'Lead', 'missing')",
      [LEAD, PIPE, STAGE, U.rep],
    );
    await c.query("INSERT INTO chat_conversations (id, kind, name) VALUES ($1, 'channel', 'sales')", [SALES]);
    await c.query("INSERT INTO chat_members (conversation_id, user_id) VALUES ($1, $2)", [SALES, U.rep]);
  });
});
afterAll(async () => db.drop());

describe("team chat's tables", () => {
  it("#general and #wins are made once, with everyone in", async () => {
    expect(await channelsOf(U.mate)).toEqual(["general", "wins"]);
    expect((await membersOf("general")).map((m) => m.user_id)).toEqual([U.rep, U.mate, U.boss].sort());
    // Migrating again makes nothing twice.
    await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
    expect(
      await owner(async (c) =>
        Number(
          (
            await c.query(
              "SELECT count(*) FROM chat_conversations WHERE kind = 'channel' AND name = 'general'",
            )
          ).rows[0].count,
        ),
      ),
    ).toBe(1);
  });

  it("a person reads only the channels they are in, and can't write in the others", async () => {
    expect(await channelsOf(U.rep)).toEqual(["general", "sales", "wins"]);
    expect(await channelsOf(U.mate)).toEqual(["general", "wins"]);
    await expect(
      app(U.mate, (c) =>
        c.query("INSERT INTO chat_messages (conversation_id, author_id, body) VALUES ($1, $2, 'hi')", [
          SALES,
          U.mate,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    // Nor as someone else, where they are a member.
    await expect(
      app(U.rep, (c) =>
        c.query("INSERT INTO chat_messages (conversation_id, author_id, body) VALUES ($1, $2, 'hi')", [
          SALES,
          U.mate,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("a lead thread follows the lead: who can see the lead reads it, and stops when the lead moves away", async () => {
    const thread = "0190e0c0-0000-7000-8000-0000000002e1";
    await app(U.rep, (c) =>
      c.query("INSERT INTO chat_conversations (id, kind, lead_id) VALUES ($1, 'lead', $2)", [thread, LEAD]),
    );
    await app(U.rep, (c) =>
      c.query(
        "INSERT INTO chat_messages (conversation_id, author_id, body) VALUES ($1, $2, 'Booked Thursday')",
        [thread, U.rep],
      ),
    );
    const read = (user: string, scope: Scope["scope"]) =>
      app(
        user,
        async (c) =>
          (await c.query("SELECT body FROM chat_messages WHERE conversation_id = $1", [thread])).rows,
        scope,
      );
    expect(await read(U.rep, "own")).toEqual([{ body: "Booked Thursday" }]);
    expect(await read(U.mate, "own")).toEqual([]);
    expect(await read(U.boss, "all")).toEqual([{ body: "Booked Thursday" }]);
    // A lead someone can't see can't be given a thread by them either.
    await expect(
      app(U.mate, (c) =>
        c.query("INSERT INTO chat_conversations (id, kind, lead_id) VALUES (gen_random_uuid(), 'lead', $1)", [
          LEAD,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    await owner((c) => c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.mate, LEAD]));
    expect(await read(U.rep, "own")).toEqual([]);
    expect(await read(U.mate, "own")).toEqual([{ body: "Booked Thursday" }]);
    await owner((c) => c.query("UPDATE leads SET owner_id = $1 WHERE id = $2", [U.rep, LEAD]));
  });

  it("a team on a channel keeps its people in: joining adds them, leaving takes them out, someone added by hand stays", async () => {
    await owner(async (c) => {
      await c.query("INSERT INTO teams (id, name) VALUES ($1, 'Closers')", [TEAM]);
      await c.query("INSERT INTO chat_channel_groups (channel_id, kind, team_id) VALUES ($1, 'team', $2)", [
        SALES,
        TEAM,
      ]);
      await c.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2), ($1, $3)", [
        TEAM,
        U.mate,
        U.rep,
      ]);
    });
    expect(await membersOf("sales")).toEqual(
      [
        { user_id: U.rep, via: "person" },
        { user_id: U.mate, via: "group" },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
    expect(await channelsOf(U.mate)).toContain("sales");
    await owner((c) => c.query("DELETE FROM team_members WHERE team_id = $1", [TEAM]));
    expect((await membersOf("sales")).map((m) => m.user_id)).toEqual([U.rep]);
    expect(await channelsOf(U.mate)).not.toContain("sales");
  });

  it("who a channel keeps in is the owner's functions' alone: the app neither reads nor changes it, the backup reads it", async () => {
    const count = "SELECT count(*)::int AS n FROM chat_channel_groups";
    await expect(app(U.rep, (c) => c.query(count), "all")).rejects.toThrow(/permission denied/);
    await expect(
      app(
        U.rep,
        (c) => c.query("INSERT INTO chat_channel_groups (channel_id, kind) VALUES ($1, 'everyone')", [SALES]),
        "all",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(app(U.rep, (c) => c.query("DELETE FROM chat_channel_groups"), "all")).rejects.toThrow(
      /permission denied/,
    );
    const kept = await owner((c) => c.query<{ n: number }>(count));
    const backup = await as("lume_readonly_backup", null, (c) => c.query<{ n: number }>(count));
    expect(backup.rows[0]!.n).toBeGreaterThan(0);
    expect(backup.rows).toEqual(kept.rows);
    // Were the grant ever given back, row security still shows the app nothing.
    await owner((c) => c.query("GRANT SELECT ON chat_channel_groups TO lume_app"));
    try {
      expect((await app(U.rep, (c) => c.query<{ n: number }>(count), "all")).rows).toEqual([{ n: 0 }]);
    } finally {
      await owner((c) => c.query("REVOKE ALL ON chat_channel_groups FROM lume_app"));
    }
  });

  it("a role on a channel keeps its people in", async () => {
    await owner(async (c) => {
      await c.query("INSERT INTO roles (id, name) VALUES ($1, 'Closers role')", [ROLE]);
      await c.query("INSERT INTO chat_channel_groups (channel_id, kind, role_id) VALUES ($1, 'role', $2)", [
        SALES,
        ROLE,
      ]);
      await c.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [U.boss, ROLE]);
    });
    expect(await channelsOf(U.boss)).toContain("sales");
    await owner((c) => c.query("DELETE FROM user_roles WHERE role_id = $1", [ROLE]));
    expect(await channelsOf(U.boss)).not.toContain("sales");
  });

  it("a disabled person is taken out of group channels, and comes back when active again", async () => {
    await owner((c) => c.query("UPDATE users SET status = 'disabled' WHERE id = $1", [U.mate]));
    expect((await membersOf("general")).map((m) => m.user_id)).not.toContain(U.mate);
    await owner((c) => c.query("UPDATE users SET status = 'active' WHERE id = $1", [U.mate]));
    expect((await membersOf("general")).map((m) => m.user_id)).toContain(U.mate);
  });

  it("the same clientId from the same person in one conversation is one message", async () => {
    const send = () =>
      app(U.rep, (c) =>
        c.query(
          "INSERT INTO chat_messages (conversation_id, author_id, body, client_id) VALUES ($1, $2, 'once', '0190e0c0-0000-7000-8000-0000000002ff')",
          [SALES, U.rep],
        ),
      );
    await send();
    await expect(send()).rejects.toMatchObject({ code: "23505" });
  });

  it("read marks and mute are one's own; folds are one's own", async () => {
    const changed = await app(
      U.mate,
      async (c) =>
        (await c.query("UPDATE chat_members SET muted = true WHERE user_id = $1", [U.rep])).rowCount,
    );
    expect(changed).toBe(0);
    await app(U.rep, (c) =>
      c.query("INSERT INTO chat_list_folds (user_id, list, folded) VALUES ($1, 'leads', true)", [U.rep]),
    );
    expect(await app(U.mate, async (c) => (await c.query("SELECT * FROM chat_list_folds")).rows)).toEqual([]);
    await expect(
      app(U.mate, (c) =>
        c.query("INSERT INTO chat_list_folds (user_id, list, folded) VALUES ($1, 'leads', true)", [U.rep]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("a direct message is made only by the function that puts its people in, never by a row of one's own", async () => {
    await expect(
      app(U.rep, (c) =>
        c.query(
          "INSERT INTO chat_conversations (id, kind, direct_key) VALUES (gen_random_uuid(), 'direct', 'made-up')",
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("nothing of one's own can be moved into a conversation one can't see, or onto someone else's message", async () => {
    const [mine, theirs] = await owner(async (c) => {
      const ids = ["0190e0c0-0000-7000-8000-00000000f001", "0190e0c0-0000-7000-8000-00000000f002"];
      await c.query(
        "INSERT INTO chat_conversations (id, kind, name) VALUES ($1, 'channel', 'move-mine'), ($2, 'channel', 'move-theirs')",
        ids,
      );
      await c.query("INSERT INTO chat_members (conversation_id, user_id) VALUES ($1, $3), ($2, $4)", [
        ...ids,
        U.rep,
        U.mate,
      ]);
      return ids;
    });
    const say = (user: string, conv: string) =>
      app(user, async (c) =>
        Number(
          (
            await c.query<{ id: string }>(
              "INSERT INTO chat_messages (conversation_id, author_id, body, client_id) VALUES ($1, $2, 'Hi', gen_random_uuid()) RETURNING id",
              [conv, user],
            )
          ).rows[0]!.id,
        ),
      );
    const [m, other] = [await say(U.rep, mine!), await say(U.mate, theirs!)];
    for (const [sql, args] of [
      [
        "UPDATE chat_members SET conversation_id = $1 WHERE user_id = $2 AND conversation_id = $3",
        [theirs, U.rep, mine],
      ],
      [
        "UPDATE chat_members SET user_id = $1 WHERE user_id = $2 AND conversation_id = $3",
        [U.boss, U.rep, mine],
      ],
      ["UPDATE chat_members SET via = 'group' WHERE user_id = $1 AND conversation_id = $2", [U.rep, mine]],
      ["UPDATE chat_messages SET conversation_id = $1 WHERE id = $2", [theirs, m]],
      ["UPDATE chat_messages SET reply_to = $1 WHERE id = $2", [other, m]],
      ["UPDATE chat_conversations SET name = 'renamed' WHERE id = $1", [mine]],
      ["UPDATE chat_conversations SET archived_at = now() WHERE id = $1", [mine]],
    ] as const)
      await expect(app(U.rep, (c) => c.query(sql, [...args]))).rejects.toThrow(/permission denied/);
    const sha = "ab".repeat(32);
    await owner((c) =>
      c.query("INSERT INTO whatsapp_files (sha256, size) VALUES ($1, 1) ON CONFLICT DO NOTHING", [sha]),
    );
    const file = "0190e0c0-0000-7000-8000-00000000f003";
    await app(U.rep, (c) =>
      c.query(
        "INSERT INTO chat_files (id, uploader_id, sha256, name, mime, kind, size) VALUES ($1, $2, $3, 'a.png', 'image/png', 'image', 1)",
        [file, U.rep, sha],
      ),
    );
    await expect(
      app(U.rep, (c) => c.query("UPDATE chat_files SET message_id = $1 WHERE id = $2", [other, file])),
    ).rejects.toThrow(/row-level security/);
    // Nor onto one they can see, that someone else wrote.
    await owner((c) =>
      c.query("INSERT INTO chat_members (conversation_id, user_id) VALUES ($1, $2)", [mine, U.mate]),
    );
    const seen = await say(U.mate, mine!);
    await expect(
      app(U.rep, (c) => c.query("UPDATE chat_files SET message_id = $1 WHERE id = $2", [seen, file])),
    ).rejects.toThrow(/row-level security/);
    await app(U.rep, (c) => c.query("UPDATE chat_files SET message_id = $1 WHERE id = $2", [m, file]));
  });

  it("no reaction on a deleted message", async () => {
    const id = await app(U.rep, async (c) => {
      const r = await c.query<{ id: string }>(
        "INSERT INTO chat_messages (conversation_id, author_id, body) VALUES ($1, $2, 'gone soon') RETURNING id",
        [SALES, U.rep],
      );
      await c.query("UPDATE chat_messages SET deleted_at = now() WHERE id = $1", [r.rows[0]!.id]);
      return r.rows[0]!.id;
    });
    await expect(
      app(U.rep, (c) =>
        c.query("INSERT INTO chat_reactions (message_id, user_id, emoji) VALUES ($1, $2, '👍')", [id, U.rep]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("threads (migration 0131)", () => {
  const OTHER = "0190e0c0-0000-7000-8000-0000000002b9";
  const said = (user: string, conv: string, more: { root?: number; also?: boolean } = {}) =>
    app(user, async (c) =>
      Number(
        (
          await c.query<{ id: string }>(
            "INSERT INTO chat_messages (conversation_id, author_id, body, thread_root, also_sent) VALUES ($1, $2, 'Hi', $3, $4) RETURNING id",
            [conv, user, more.root ?? null, more.also ?? false],
          )
        ).rows[0]!.id,
      ),
    );
  beforeAll(async () => {
    await owner(async (c) => {
      await c.query("INSERT INTO chat_conversations (id, kind, name) VALUES ($1, 'channel', 'threads')", [
        OTHER,
      ]);
      await c.query("INSERT INTO chat_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)", [
        OTHER,
        U.rep,
        U.boss,
      ]);
    });
  });

  it("a reply hangs on a message of its own conversation that isn't itself a reply", async () => {
    const root = await said(U.rep, OTHER);
    const r = await said(U.boss, OTHER, { root });
    const elsewhere = await said(U.rep, SALES);
    for (const bad of [r, elsewhere, 9_999_999_999])
      await expect(said(U.rep, OTHER, { root: bad })).rejects.toThrow(/own conversation/);
    // Also sent is a reply's alone.
    await expect(said(U.rep, OTHER, { also: true })).rejects.toThrow(/chat_messages_also_sent/);
    // Nor is one moved to another thread afterwards.
    await expect(
      app(U.boss, (c) => c.query("UPDATE chat_messages SET thread_root = NULL WHERE id = $1", [r])),
    ).rejects.toThrow(/permission denied/);
  });

  it("a thread is seen by whoever may read its conversation, and written by nobody's own hand", async () => {
    const root = await said(U.rep, OTHER);
    await said(U.boss, OTHER, { root });
    const seen = (u: string) =>
      app(
        u,
        async (c) => (await c.query("SELECT 1 FROM chat_threads WHERE root_id = $1", [root])).rows.length,
      );
    expect([await seen(U.rep), await seen(U.boss), await seen(U.mate)]).toEqual([1, 1, 0]);
    for (const q of [
      "UPDATE chat_threads SET replies = 99",
      "DELETE FROM chat_threads",
      "INSERT INTO chat_threads (root_id, conversation_id, last_reply_id, last_at) SELECT 1, id, 1, now() FROM chat_conversations LIMIT 1",
    ])
      await expect(app(U.rep, (c) => c.query(q))).rejects.toThrow(/permission denied/);
    await expect(app(U.rep, (c) => c.query("SELECT lume_chat_reply_landed()"))).rejects.toThrow();
    const worker = (q: string) => as("lume_worker", { scope: "all", user: U.rep }, (c) => c.query(q));
    await expect(worker("SELECT 1 FROM chat_threads")).rejects.toThrow(/permission denied/);
    await expect(worker("SELECT 1 FROM chat_thread_places")).rejects.toThrow(/permission denied/);
  });

  it("a place in a thread is one's own: not another's to see, make, move or take away", async () => {
    const root = await said(U.rep, OTHER);
    const reply = await said(U.boss, OTHER, { root });
    const places = (u: string) =>
      app(u, async (c) =>
        (
          await c.query<{ user_id: string; last_read_id: string; last_reply_id: string }>(
            "SELECT user_id, last_read_id, last_reply_id FROM chat_thread_places WHERE root_id = $1",
            [root],
          )
        ).rows.map((r) => ({
          ...r,
          last_read_id: Number(r.last_read_id),
          last_reply_id: Number(r.last_reply_id),
        })),
      );
    expect(await places(U.rep)).toEqual([{ user_id: U.rep, last_read_id: 0, last_reply_id: reply }]);
    expect(await places(U.boss)).toEqual([{ user_id: U.boss, last_read_id: reply, last_reply_id: reply }]);
    const make = (u: string, whose: string, on: number) =>
      app(u, (c) =>
        c.query("INSERT INTO chat_thread_places (root_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
          on,
          whose,
        ]),
      );
    await expect(make(U.mate, U.mate, root)).rejects.toThrow(/row-level security/);
    await expect(make(U.rep, U.mate, root)).rejects.toThrow(/row-level security/);
    // On a reply there is no thread to have a place in.
    await expect(make(U.rep, U.rep, reply)).rejects.toThrow(/row-level security/);
    for (const q of [
      "UPDATE chat_thread_places SET last_reply_id = 0",
      "UPDATE chat_thread_places SET user_id = lume_user()",
      "DELETE FROM chat_thread_places",
    ])
      await expect(app(U.rep, (c) => c.query(q))).rejects.toThrow(/permission denied/);
    await app(U.rep, (c) =>
      c.query("UPDATE chat_thread_places SET following = false WHERE root_id = $1", [root]),
    );
    // Every row at once, read or not: still only their own.
    const all = await app(U.rep, (c) => c.query("UPDATE chat_thread_places SET following = true"));
    expect(all.rowCount).toBeGreaterThan(0);
    await app(U.rep, (c) => c.query("UPDATE chat_thread_places SET following = false"));
    const bosses = await app(
      U.boss,
      async (c) =>
        (await c.query("SELECT following FROM chat_thread_places WHERE root_id = $1", [root])).rows,
    );
    expect(bosses).toEqual([{ following: true }]);
  });

  it("a reply marked deleted twice is one fewer, once", async () => {
    const root = await said(U.rep, OTHER);
    const [a] = [await said(U.rep, OTHER, { root }), await said(U.rep, OTHER, { root })];
    for (let i = 0; i < 2; i++)
      await app(U.rep, (c) => c.query("UPDATE chat_messages SET deleted_at = now() WHERE id = $1", [a]));
    const t = await app(
      U.rep,
      async (c) => (await c.query("SELECT replies FROM chat_threads WHERE root_id = $1", [root])).rows,
    );
    expect(t).toEqual([{ replies: 1 }]);
  });

  it("a message deleted for good takes its thread with it, and its replies", async () => {
    const root = await said(U.rep, OTHER);
    await said(U.boss, OTHER, { root });
    await owner((c) => c.query("DELETE FROM chat_conversations WHERE id = $1", [OTHER]));
    const left = await owner(
      async (c) =>
        (
          await c.query<{ t: number; p: number }>(
            "SELECT (SELECT count(*)::int FROM chat_threads WHERE root_id = $1) AS t, (SELECT count(*)::int FROM chat_thread_places WHERE root_id = $1) AS p",
            [root],
          )
        ).rows[0],
    );
    expect(left).toEqual({ t: 0, p: 0 });
  });
});

describe("who a message names (migration 0132)", () => {
  it("is written by its author alone, and seen with the message", async () => {
    const m = await app(U.rep, async (c) =>
      Number(
        (
          await c.query<{ id: string }>(
            "INSERT INTO chat_messages (conversation_id, author_id, body) VALUES ($1, $2, 'Hi') RETURNING id",
            [SALES, U.rep],
          )
        ).rows[0]!.id,
      ),
    );
    const name = (u: string, conv = SALES) =>
      app(u, (c) =>
        c.query(
          "INSERT INTO chat_mentions (message_id, user_id, by_name, conversation_id) VALUES ($1, $2, true, $3)",
          [m, U.boss, conv],
        ),
      );
    await expect(name(U.mate)).rejects.toThrow(/row-level security/);
    await owner((c) =>
      c.query("INSERT INTO chat_members (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
        SALES,
        U.mate,
      ]),
    );
    await expect(name(U.mate)).rejects.toThrow(/row-level security/);
    // Not as said somewhere else.
    const general = await app(
      U.rep,
      async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM chat_conversations WHERE name = 'general'")).rows[0]!
          .id,
    );
    await expect(name(U.rep, general)).rejects.toThrow(/row-level security/);
    await name(U.rep);
    const seen = (u: string) =>
      app(
        u,
        async (c) => (await c.query("SELECT 1 FROM chat_mentions WHERE message_id = $1", [m])).rows.length,
      );
    expect([await seen(U.rep), await seen(U.mate), await seen(U.boss)]).toEqual([1, 1, 0]);
    // Whom it names says they've seen it; nobody else does.
    const look = (u: string) =>
      app(
        u,
        async (c) =>
          (await c.query("UPDATE chat_mentions SET seen = true WHERE message_id = $1", [m])).rowCount,
      );
    expect(await look(U.mate)).toBe(0);
    for (const q of ["UPDATE chat_mentions SET user_id = user_id", "DELETE FROM chat_mentions"])
      await expect(app(U.rep, (c) => c.query(q))).rejects.toThrow(/permission denied/);
    await expect(
      as("lume_worker", { scope: "all", user: U.rep }, (c) => c.query("SELECT 1 FROM chat_mentions")),
    ).rejects.toThrow(/permission denied/);
  });
});
