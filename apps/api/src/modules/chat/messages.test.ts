import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { heldOpen } from "../../../test/held";

/** Team Chat's messages (plan 2026-11-24-team-chat-2a, Task 4): send once, reply, react, edit, delete, read marks. */
let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
let mate: SeededUser;
let outsider: SeededUser;
let ch: string;

type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const as = async (u: SeededUser, method: M, url: string, payload?: Record<string, unknown>) =>
  (await h.signIn(u)).inject({ method, url, ...(payload ? { payload } : {}) });
const send = (u: SeededUser, body: Record<string, unknown>, conv = ch) =>
  as(u, "POST", `/api/v1/chat/${conv}/messages`, { clientId: crypto.randomUUID(), ...body });
const page = async (u: SeededUser, conv = ch) => (await as(u, "GET", `/api/v1/chat/${conv}/messages`)).json();
const use = { key: "chat.use", scope: null } as const;

/** A row as a person reads it (row security is forced, so the owner's own reads see none of chat). */
const readAs = async <T extends Record<string, unknown>>(
  u: SeededUser,
  q: string,
  params: unknown[],
): Promise<T[]> => {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [u.id]);
    return (await c.query<T>(q, params)).rows;
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
};

beforeAll(async () => {
  h = await createHarness();
  admin = await h.seedUser({
    name: "Maya Kapoor",
    grants: [use, { key: "chat.channels.manage", scope: null }],
  });
  rep = await h.seedUser({ name: "Rahul Mehta", grants: [use] });
  mate = await h.seedUser({ name: "Sana Iqbal", grants: [use] });
  outsider = await h.seedUser({ name: "Arjun Nair", grants: [use] });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.ownerPool.query("TRUNCATE chat_conversations CASCADE");
  ch = (await as(admin, "POST", "/api/v1/chat/channels", { name: "sales", people: [rep.id, mate.id] })).json()
    .id;
});

describe("POST /api/v1/chat/:id/messages", () => {
  it("a send lands once, comes back in order, and moves the conversation's last message", async () => {
    const a = await send(rep, { body: "  First  " });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({
      authorId: rep.id,
      body: "First",
      replyTo: null,
      files: [],
      reactions: [],
    });
    await send(mate, { body: "Second" });
    const p = await page(admin);
    expect(p.messages.map((m: { body: string }) => m.body)).toEqual(["First", "Second"]);
    const [conv] = await readAs<{ last_message_id: string }>(
      admin,
      "SELECT last_message_id FROM chat_conversations WHERE id = $1",
      [ch],
    );
    expect(Number(conv!.last_message_id)).toBe(p.messages[1].id);
  });

  it("the same clientId twice, and twice at once, is one message, and both answers are it", async () => {
    const clientId = crypto.randomUUID();
    const one = await as(rep, "POST", `/api/v1/chat/${ch}/messages`, { clientId, body: "Once" });
    const two = await as(rep, "POST", `/api/v1/chat/${ch}/messages`, { clientId, body: "Once" });
    expect(two.statusCode).toBe(200);
    expect(two.json().id).toBe(one.json().id);
    // A send still being written by another tab: this one waits for it, then answers with it.
    const racing = crypto.randomUUID();
    const held = await heldOpen(h, rep.id, (c) =>
      c.query(
        "INSERT INTO chat_messages (conversation_id, author_id, body, client_id) VALUES ($1, $2, 'Raced', $3)",
        [ch, rep.id, racing],
      ),
    );
    const second = as(rep, "POST", `/api/v1/chat/${ch}/messages`, { clientId: racing, body: "Raced" });
    await held.commitOnceWaited();
    const r = await second;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().body).toBe("Raced");
    expect((await page(rep)).messages.filter((m: { body: string }) => m.body === "Raced")).toHaveLength(1);
  });

  it("4,000 characters go, 4,001 don't; only spaces doesn't", async () => {
    expect((await send(rep, { body: "x".repeat(4000) })).statusCode).toBe(201);
    const long = await send(rep, { body: "x".repeat(4001) });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.message).toBe("A message can be at most 4,000 characters.");
    expect((await send(rep, { body: "  \n " })).json().error.message).toBe("Write a message or add a file.");
  });

  it("someone who isn't a member can't read, send or react: the channel isn't there for them", async () => {
    const m = (await send(rep, { body: "Ours" })).json();
    expect((await as(outsider, "GET", `/api/v1/chat/${ch}/messages`)).statusCode).toBe(404);
    expect((await send(outsider, { body: "Let me in" })).statusCode).toBe(404);
    expect(
      (await as(outsider, "PUT", `/api/v1/chat/messages/${m.id}/reactions/${encodeURIComponent("👍")}`))
        .statusCode,
    ).toBe(404);
  });

  it("a reply to a message in another conversation, or to a deleted one, is refused", async () => {
    const other = (await as(rep, "POST", "/api/v1/chat/direct", { people: [mate.id] })).json().id;
    const elsewhere = (await send(rep, { body: "Elsewhere" }, other)).json();
    expect((await send(rep, { body: "Re", replyTo: elsewhere.id })).statusCode).toBe(400);
    const here = (await send(mate, { body: "Here" })).json();
    const reply = (await send(rep, { body: "Re", replyTo: here.id })).json();
    expect(reply.replyTo).toMatchObject({ id: here.id, authorId: mate.id, body: "Here" });
    await as(mate, "DELETE", `/api/v1/chat/messages/${here.id}`);
    expect((await send(rep, { body: "Re again", replyTo: here.id })).statusCode).toBe(400);
  });
});

describe("edit, delete, react, read", () => {
  it("only the author edits or deletes; an edit keeps the old words for the audit", async () => {
    const m = (await send(rep, { body: "Teh price" })).json();
    expect((await as(mate, "PATCH", `/api/v1/chat/messages/${m.id}`, { body: "Hacked" })).statusCode).toBe(
      404,
    );
    expect((await as(mate, "DELETE", `/api/v1/chat/messages/${m.id}`)).statusCode).toBe(404);
    const e = await as(rep, "PATCH", `/api/v1/chat/messages/${m.id}`, { body: "The price" });
    expect(e.statusCode, e.body).toBe(200);
    expect(e.json()).toMatchObject({ body: "The price", editedAt: expect.any(String) });
    expect(await readAs(rep, "SELECT body FROM chat_message_edits WHERE message_id = $1", [m.id])).toEqual([
      { body: "Teh price" },
    ]);
    expect(
      (
        await h.queryAll<{ action: string }>(
          "SELECT action FROM audit_log WHERE action LIKE 'chat.message.%'",
        )
      ).map((a) => a.action),
    ).toContain("chat.message.edited");
  });

  it("a deleted message answers with no words and no files, and takes no reaction", async () => {
    const m = (await send(rep, { body: "Oops, wrong chat" })).json();
    await as(rep, "PUT", `/api/v1/chat/messages/${m.id}/reactions/${encodeURIComponent("👍")}`);
    expect((await as(rep, "DELETE", `/api/v1/chat/messages/${m.id}`)).statusCode).toBe(204);
    const [gone] = (await page(mate)).messages;
    expect(gone).toMatchObject({
      id: m.id,
      body: null,
      files: [],
      reactions: [],
      deletedAt: expect.any(String),
    });
    expect(
      (await as(mate, "PUT", `/api/v1/chat/messages/${m.id}/reactions/${encodeURIComponent("🔥")}`))
        .statusCode,
    ).toBe(400);
  });

  it("a reaction is one emoji, counted once per person, and taken back", async () => {
    const m = (await send(rep, { body: "Booked!" })).json();
    const party = encodeURIComponent("🎉");
    await as(mate, "PUT", `/api/v1/chat/messages/${m.id}/reactions/${party}`);
    await as(mate, "PUT", `/api/v1/chat/messages/${m.id}/reactions/${party}`);
    await as(admin, "PUT", `/api/v1/chat/messages/${m.id}/reactions/${party}`);
    expect((await page(mate)).messages[0].reactions).toEqual([{ emoji: "🎉", count: 2, mine: true }]);
    await as(mate, "DELETE", `/api/v1/chat/messages/${m.id}/reactions/${party}`);
    expect((await page(mate)).messages[0].reactions).toEqual([{ emoji: "🎉", count: 1, mine: false }]);
    expect(
      (await as(mate, "PUT", `/api/v1/chat/messages/${m.id}/reactions/${encodeURIComponent("not an emoji")}`))
        .statusCode,
    ).toBe(400);
  });

  it("read never goes backwards, and own messages never count as unread", async () => {
    const a = (await send(rep, { body: "One" })).json();
    const b = (await send(rep, { body: "Two" })).json();
    expect((await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: b.id })).statusCode).toBe(204);
    await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: a.id });
    expect((await page(mate)).lastReadId).toBe(b.id);
    const repRow = (await as(rep, "GET", "/api/v1/chat"))
      .json()
      .channels.find((c: { id: string }) => c.id === ch);
    expect(repRow.unread).toBe(0);
  });

  it("pages of 50, newest page first, oldest first within it", async () => {
    for (let i = 0; i < 55; i++) await send(rep, { body: `m${i}` });
    const first = await page(rep);
    expect(first.messages).toHaveLength(50);
    expect(first.messages[0].body).toBe("m5");
    expect(first.messages[49].body).toBe("m54");
    const older = (await as(rep, "GET", `/api/v1/chat/${ch}/messages?before=${first.messages[0].id}`)).json();
    expect(older.messages.map((m: { body: string }) => m.body)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });
});
