import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { chatEventOf } from "../notifications/hub";
import { threadTuning } from "./threads";

/** Team Chat's threads (plan 2026-11-25-team-chat-2b, Task 1): replies on a message, read apart from its conversation. */
let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
let mate: SeededUser;
let outsider: SeededUser;
let ch: string;

type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Msg = {
  id: number;
  body: string | null;
  threadRoot: number | null;
  alsoSent: boolean;
  thread: { replies: number; lastAt: string; faces: string[] } | null;
  deletedAt: string | null;
};
const as = async (u: SeededUser, method: M, url: string, payload?: Record<string, unknown>) =>
  (await h.signIn(u)).inject({ method, url, ...(payload ? { payload } : {}) });
const say = async (u: SeededUser, body: string, conv = ch): Promise<Msg> => {
  const r = await as(u, "POST", `/api/v1/chat/${conv}/messages`, { clientId: crypto.randomUUID(), body });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
};
const reply = (u: SeededUser, to: number, body: string, more: Record<string, unknown> = {}) =>
  as(u, "POST", `/api/v1/chat/messages/${to}/thread`, { clientId: crypto.randomUUID(), body, ...more });
const replied = async (u: SeededUser, to: number, body: string, more: Record<string, unknown> = {}) => {
  const r = await reply(u, to, body, more);
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as Msg;
};
const page = async (u: SeededUser, conv = ch): Promise<{ messages: Msg[]; lastReadId: number | null }> =>
  (await as(u, "GET", `/api/v1/chat/${conv}/messages`)).json();
const thread = async (
  u: SeededUser,
  mid: number,
  q = "",
): Promise<{
  root: number;
  conversationId: string;
  messages: Msg[];
  more: boolean;
  lastReadId: number | null;
  following: boolean;
}> => (await as(u, "GET", `/api/v1/chat/messages/${mid}/thread${q}`)).json();
const list = async (u: SeededUser) => (await as(u, "GET", "/api/v1/chat")).json();
const unreadIn = async (u: SeededUser, conv = ch) =>
  (await list(u)).channels.find((c: { id: string }) => c.id === conv)?.unread;
const followed = async (
  u: SeededUser,
): Promise<{ root: Msg; unread: number; conversation: { id: string } }[]> =>
  (await as(u, "GET", "/api/v1/chat/threads")).json().threads;
const bodies = (ms: Msg[]) => ms.map((m) => m.body);
const use = { key: "chat.use", scope: null } as const;

beforeAll(async () => {
  h = await createHarness();
  admin = await h.seedUser({
    name: "Maya Kapoor",
    grants: [use, { key: "chat.channels.manage", scope: null }, { key: "leads.view", scope: "all" }],
  });
  rep = await h.seedUser({ name: "Rahul Mehta", grants: [use, { key: "leads.view", scope: "own" }] });
  mate = await h.seedUser({ name: "Sana Iqbal", grants: [use, { key: "leads.view", scope: "own" }] });
  outsider = await h.seedUser({ name: "Arjun Nair", grants: [use, { key: "leads.view", scope: "own" }] });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.ownerPool.query("TRUNCATE chat_conversations CASCADE");
  ch = (await as(admin, "POST", "/api/v1/chat/channels", { name: "sales", people: [rep.id, mate.id] })).json()
    .id;
});

describe("a reply in a thread", () => {
  it("joins the thread and leaves the conversation's page, unread and order alone", async () => {
    const root = await say(rep, "Who takes Thursday?");
    await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: root.id });
    const before = (await list(mate)).channels.find((c: { id: string }) => c.id === ch);
    const r = await replied(mate, root.id, "I do");
    expect(r).toMatchObject({ threadRoot: root.id, alsoSent: false, thread: null });
    expect(bodies((await page(rep)).messages)).toEqual(["Who takes Thursday?"]);
    expect(await unreadIn(rep)).toBe(0);
    expect(await unreadIn(mate)).toBe(0);
    expect((await list(mate)).channels.find((c: { id: string }) => c.id === ch).lastAt).toBe(before.lastAt);
    const t = await thread(rep, root.id);
    expect(bodies(t.messages)).toEqual(["Who takes Thursday?", "I do"]);
    expect(t).toMatchObject({ root: root.id, conversationId: ch, more: false, following: true });
    // On the message in the conversation: how many, who, and when.
    expect((await page(rep)).messages[0]!.thread).toEqual({
      replies: 1,
      lastAt: expect.any(String),
      faces: [mate.id],
    });
  });

  it("a conversation's unread counts its own messages alone, with replies among them", async () => {
    const root = await say(rep, "Root");
    await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: root.id });
    for (let i = 0; i < 3; i++) await replied(rep, root.id, `r${i}`);
    await say(rep, "In the channel");
    expect(await unreadIn(mate)).toBe(1);
  });

  it("also sent is in both, once, and counts in the conversation alone", async () => {
    const root = await say(rep, "Price for ten?");
    const r = await replied(mate, root.id, "Eight thousand", { alsoSend: true });
    expect(r).toMatchObject({ threadRoot: root.id, alsoSent: true });
    expect(bodies((await page(rep)).messages)).toEqual(["Price for ten?", "Eight thousand"]);
    expect(bodies((await thread(rep, root.id)).messages)).toEqual(["Price for ten?", "Eight thousand"]);
    expect(await unreadIn(rep)).toBe(1);
    expect((await list(rep)).threads).toEqual({ any: true, unread: 0 });
    expect((await list(rep)).unread).toBe(1);
    // Unread in the thread already: one also sent is the conversation's, never counted twice.
    await replied(mate, root.id, "Ten for fifteen");
    await replied(mate, root.id, "Or twelve", { alsoSend: true });
    expect((await list(rep)).threads.unread).toBe(1);
    expect((await followed(rep))[0]!.unread).toBe(1);
    await as(rep, "PUT", `/api/v1/chat/messages/${root.id}/thread/read`, { upTo: Number.MAX_SAFE_INTEGER });
    // It leaves nothing behind it in the thread: one more reply is one unread there.
    await replied(mate, root.id, "And nine for twelve");
    expect((await list(rep)).threads.unread).toBe(1);
  });

  it("a reply to a reply goes to its root, and one sent with the reply's id opens the same thread", async () => {
    const root = await say(rep, "Root");
    const one = await replied(mate, root.id, "One");
    const two = await replied(rep, one.id, "Two");
    expect(two.threadRoot).toBe(root.id);
    expect((await thread(mate, one.id)).root).toBe(root.id);
    expect(bodies((await thread(mate, one.id)).messages)).toEqual(["Root", "One", "Two"]);
  });

  it("the same reply sent twice, and twice at once, is one, counted once", async () => {
    const root = await say(rep, "Root");
    const clientId = crypto.randomUUID();
    const url = `/api/v1/chat/messages/${root.id}/thread`;
    const got = await Promise.all([1, 2, 3].map(() => as(mate, "POST", url, { clientId, body: "Once" })));
    expect(got.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
    expect(new Set(got.map((r) => r.json().id)).size).toBe(1);
    expect((await page(rep)).messages[0]!.thread!.replies).toBe(1);
  });

  it("faces are the last three people, the latest first, each once", async () => {
    const more = await h.seedUser({ name: "Dev Rao", grants: [use] });
    await as(admin, "PUT", `/api/v1/chat/channels/${ch}/members`, {
      people: [admin.id, rep.id, mate.id, more.id],
      groups: [],
    });
    const root = await say(rep, "Root");
    for (const u of [rep, mate, rep, admin, rep]) await replied(u, root.id, "hi");
    expect((await page(rep)).messages[0]!.thread!.faces).toEqual([rep.id, admin.id, mate.id]);
    for (const u of [mate, admin, more]) await replied(u, root.id, "hi");
    const t = (await page(rep)).messages[0]!.thread!;
    expect(t.faces).toEqual([more.id, admin.id, mate.id]);
    expect(t.replies).toBe(8);
  });

  it("answers only what is in its thread: a quote of the conversation's other messages is refused, and the reverse", async () => {
    const root = await say(rep, "Root");
    const other = await say(rep, "Other");
    const inside = await replied(mate, root.id, "Inside");
    expect((await reply(rep, root.id, "x", { replyTo: other.id })).statusCode).toBe(400);
    expect((await reply(rep, root.id, "x", { replyTo: root.id })).statusCode).toBe(201);
    expect((await reply(rep, root.id, "x", { replyTo: inside.id })).statusCode).toBe(201);
    const out = await as(rep, "POST", `/api/v1/chat/${ch}/messages`, {
      clientId: crypto.randomUUID(),
      body: "x",
      replyTo: inside.id,
    });
    expect(out.statusCode).toBe(400);
  });

  it("follows the words' rules: empty, too long, and eleven files are refused in words", async () => {
    const root = await say(rep, "Root");
    expect((await reply(rep, root.id, "  ")).json().error.message).toBe("Write a message or add a file.");
    expect((await reply(rep, root.id, "x".repeat(4001))).json().error.message).toBe(
      "A message can be at most 4,000 characters.",
    );
    const eleven = Array.from({ length: 11 }, () => crypto.randomUUID());
    expect((await reply(rep, root.id, "x", { files: eleven })).statusCode).toBe(400);
  });
});

describe("deleting", () => {
  it("a deleted root keeps its thread, its words gone, and the thread goes on", async () => {
    const root = await say(rep, "Wrong chat");
    await replied(mate, root.id, "Noted");
    await as(rep, "DELETE", `/api/v1/chat/messages/${root.id}`);
    const t = await thread(mate, root.id);
    expect(t.messages[0]).toMatchObject({ id: root.id, body: null, deletedAt: expect.any(String) });
    expect(bodies(t.messages)).toEqual([null, "Noted"]);
    expect((await page(mate)).messages[0]!.thread!.replies).toBe(1);
    expect((await reply(rep, root.id, "Sorry")).statusCode).toBe(201);
    // Nothing starts under a deleted message with no thread.
    const lone = await say(rep, "Gone");
    await as(rep, "DELETE", `/api/v1/chat/messages/${lone.id}`);
    const no = await reply(mate, lone.id, "Too late");
    expect(no.statusCode).toBe(400);
    expect(no.json().error.message).toBe("That message was deleted.");
  });

  it("a deleted reply isn't counted or unread, and the last one gone takes the thread off its message", async () => {
    const root = await say(rep, "Root");
    const one = await replied(mate, root.id, "One");
    const two = await replied(mate, root.id, "Two");
    expect((await list(rep)).threads.unread).toBe(2);
    await as(mate, "DELETE", `/api/v1/chat/messages/${one.id}`);
    expect((await list(rep)).threads.unread).toBe(1);
    expect((await page(rep)).messages[0]!.thread!.replies).toBe(1);
    await as(mate, "DELETE", `/api/v1/chat/messages/${two.id}`);
    expect((await page(rep)).messages[0]!.thread).toBeNull();
    expect((await list(rep)).threads.unread).toBe(0);
    expect(await followed(rep)).toEqual([]);
    // The message says what's left: the last reply's time and whose it was.
    await replied(admin, root.id, "Four");
    const last = await replied(mate, root.id, "Five");
    await as(mate, "DELETE", `/api/v1/chat/messages/${last.id}`);
    expect((await page(rep)).messages[0]!.thread).toMatchObject({ replies: 1, faces: [admin.id] });
    const four = (await thread(rep, root.id)).messages.find((m) => m.body === "Four")!;
    await as(admin, "DELETE", `/api/v1/chat/messages/${four.id}`);
    // Deleting the same one again takes nothing more off.
    await replied(mate, root.id, "Three");
    await as(mate, "DELETE", `/api/v1/chat/messages/${two.id}`);
    expect((await page(rep)).messages[0]!.thread!.replies).toBe(1);
  });
});

describe("following", () => {
  it("the root's writer and whoever replies follow; a reader who said nothing doesn't", async () => {
    const root = await say(rep, "Root");
    await replied(mate, root.id, "One");
    expect((await followed(rep)).map((t) => t.root.id)).toEqual([root.id]);
    expect((await followed(mate)).map((t) => t.root.id)).toEqual([root.id]);
    expect(await followed(admin)).toEqual([]);
    expect((await list(admin)).threads).toEqual({ any: false, unread: 0 });
    expect((await list(rep)).threads).toEqual({ any: true, unread: 1 });
    expect((await list(rep)).unread).toBe(1);
    expect((await as(rep, "GET", "/api/v1/chat/unread")).json().unread).toBe(1);
    // One's own is read as it's sent.
    expect((await list(mate)).threads.unread).toBe(0);
  });

  it("stopping sticks while others reply, and their own next reply follows it again", async () => {
    const root = await say(rep, "Root");
    await replied(mate, root.id, "One");
    const url = `/api/v1/chat/messages/${root.id}/thread/following`;
    expect((await as(rep, "PUT", url, { on: false })).statusCode).toBe(204);
    await replied(mate, root.id, "Two");
    expect((await list(rep)).threads).toEqual({ any: false, unread: 0 });
    expect((await as(rep, "GET", "/api/v1/chat/unread")).json().unread).toBe(0);
    expect(await followed(rep)).toEqual([]);
    expect((await thread(rep, root.id)).following).toBe(false);
    // Followed again by hand: from now on.
    await as(rep, "PUT", url, { on: true });
    expect((await list(rep)).threads).toEqual({ any: true, unread: 0 });
    await as(rep, "PUT", url, { on: false });
    await replied(rep, root.id, "Three");
    expect((await thread(rep, root.id)).following).toBe(true);
    await replied(mate, root.id, "Four");
    expect((await list(rep)).threads.unread).toBe(1);
  });

  it("someone who starts following has nothing waiting from before, and hears what comes after", async () => {
    const root = await say(rep, "Root");
    await replied(mate, root.id, "One");
    const url = `/api/v1/chat/messages/${root.id}/thread/following`;
    await as(admin, "PUT", url, { on: true });
    await as(admin, "PUT", url, { on: true });
    expect((await list(admin)).threads).toEqual({ any: true, unread: 0 });
    await replied(mate, root.id, "Two");
    expect((await list(admin)).threads.unread).toBe(1);
  });

  it("read moves one's own place, never backwards, never past the last reply, and makes none", async () => {
    const root = await say(rep, "Root");
    const one = await replied(mate, root.id, "One");
    const two = await replied(mate, root.id, "Two");
    const url = `/api/v1/chat/messages/${root.id}/thread/read`;
    expect((await as(rep, "PUT", url, { upTo: one.id })).statusCode).toBe(204);
    expect((await list(rep)).threads.unread).toBe(1);
    await as(rep, "PUT", url, { upTo: Number.MAX_SAFE_INTEGER });
    expect((await thread(rep, root.id)).lastReadId).toBe(two.id);
    await as(rep, "PUT", url, { upTo: one.id });
    expect((await thread(rep, root.id)).lastReadId).toBe(two.id);
    await replied(mate, root.id, "Three");
    expect((await list(rep)).threads.unread).toBe(1);
    await as(admin, "PUT", url, { upTo: two.id });
    expect((await thread(admin, root.id)).lastReadId).toBeNull();
    expect(await followed(admin)).toEqual([]);
  });

  it("a muted conversation's threads are listed and never add to the number", async () => {
    const root = await say(rep, "Root");
    await replied(mate, root.id, "One");
    await as(rep, "PUT", `/api/v1/chat/${ch}/mute`, { muted: true });
    expect((await list(rep)).threads).toEqual({ any: true, unread: 0 });
    expect((await as(rep, "GET", "/api/v1/chat/unread")).json().unread).toBe(0);
    expect((await followed(rep))[0]!.unread).toBe(1);
  });

  it("a deleted reply isn't new in the list of threads either", async () => {
    const root = await say(rep, "Root");
    const one = await replied(mate, root.id, "One");
    await replied(mate, root.id, "Two");
    await as(mate, "DELETE", `/api/v1/chat/messages/${one.id}`);
    expect((await followed(rep))[0]!.unread).toBe(1);
  });

  it("already following, named in a reply: what was unread before it stays unread", async () => {
    const root = await say(rep, "Root");
    await replied(mate, root.id, "One");
    await replied(mate, root.id, "Two");
    await replied(mate, root.id, `<@${rep.id}> three`);
    expect((await list(rep)).threads.unread).toBe(3);
  });

  it("read while not following, then named in an old reply: what was read stays read", async () => {
    const root = await say(rep, "Root");
    const one = await replied(mate, root.id, "One");
    await as(rep, "PUT", `/api/v1/chat/messages/${root.id}/thread/following`, { on: false });
    await replied(mate, root.id, "Two");
    const last = await replied(mate, root.id, "Three");
    await as(rep, "PUT", `/api/v1/chat/messages/${root.id}/thread/read`, { upTo: last.id });
    await as(mate, "PATCH", `/api/v1/chat/messages/${one.id}`, { body: `One <@${rep.id}>` });
    expect((await list(rep)).threads.unread).toBe(0);
  });

  it("threads whose only news is also in the conversation never hide one that counts", async () => {
    const mine = await say(rep, "Counts");
    for (let i = 0; i < 101; i++) {
      const r = await say(rep, `A${i}`);
      await replied(mate, r.id, "x", { alsoSend: true });
    }
    await replied(mate, mine.id, "y");
    expect((await list(rep)).threads.unread).toBe(1);
  }, 90_000);

  it("a hundred unread threads that don't count never hide one that does", async () => {
    const quiet = (
      await as(admin, "POST", "/api/v1/chat/channels", { name: "quiet", people: [rep.id, mate.id] })
    ).json().id;
    const mine = await say(rep, "Counts");
    await replied(mate, mine.id, "x");
    await as(rep, "PUT", `/api/v1/chat/${quiet}/mute`, { muted: true });
    for (let i = 0; i < 101; i++) await replied(mate, (await say(rep, `Q${i}`, quiet)).id, "x");
    expect((await list(rep)).threads.unread).toBe(1);
  }, 60_000);

  it("the newest reply first, fifty at most, past threads in places they've left since", async () => {
    const was = threadTuning.places;
    threadTuning.places = 2;
    try {
      const mine: number[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await say(rep, `Root ${i}`);
        await replied(mate, r.id, "x");
        mine.push(r.id);
      }
      const other = (
        await as(admin, "POST", "/api/v1/chat/channels", { name: "gone", people: [rep.id, mate.id] })
      ).json().id;
      for (let i = 0; i < 3; i++) await replied(mate, (await say(rep, `There ${i}`, other)).id, "x");
      await as(admin, "PUT", `/api/v1/chat/channels/${other}/members`, { people: [admin.id], groups: [] });
      await replied(mate, mine[0]!, "Newest");
      expect((await followed(rep)).map((t) => t.root.body)).toEqual(["Root 0", "Root 2", "Root 1"]);
      // The threads they can't read any more aren't in their number either.
      expect((await list(rep)).threads.unread).toBe(4);
    } finally {
      threadTuning.places = was;
    }
  });
});

describe("who may", () => {
  it("someone outside the channel: every thread route says it isn't there", async () => {
    const root = await say(rep, "Ours");
    await replied(mate, root.id, "Yes");
    const base = `/api/v1/chat/messages/${root.id}/thread`;
    expect((await as(outsider, "GET", base)).statusCode).toBe(404);
    expect((await reply(outsider, root.id, "Let me in")).statusCode).toBe(404);
    expect((await as(outsider, "PUT", `${base}/read`, { upTo: 1 })).statusCode).toBe(404);
    expect((await as(outsider, "PUT", `${base}/following`, { on: true })).statusCode).toBe(404);
    expect((await as(rep, "GET", "/api/v1/chat/messages/999999999/thread")).statusCode).toBe(404);
  });

  it("a thread in a conversation left, or archived, is gone from the list, the count and the page", async () => {
    const root = await say(rep, "Root");
    await replied(mate, root.id, "One");
    await as(admin, "PUT", `/api/v1/chat/channels/${ch}/members`, {
      people: [admin.id, mate.id],
      groups: [],
    });
    expect(await followed(rep)).toEqual([]);
    expect((await list(rep)).threads.unread).toBe(0);
    expect((await as(rep, "GET", `/api/v1/chat/messages/${root.id}/thread`)).statusCode).toBe(404);
    // Someone else's reply first, so there is something unread in what's archived.
    await replied(admin, root.id, "Two");
    expect((await list(mate)).threads.unread).toBe(1);
    await as(admin, "PATCH", `/api/v1/chat/channels/${ch}`, { archived: true });
    expect(await followed(mate)).toEqual([]);
    expect((await list(mate)).threads.unread).toBe(0);
    expect((await as(mate, "GET", `/api/v1/chat/messages/${root.id}/thread`)).statusCode).toBe(404);
    expect((await reply(mate, root.id, "x")).statusCode).toBe(404);
  });

  it("a lead's thread moves away with its lead; a first reply there keeps a place with nothing waiting", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Asha" });
    const conv = (await as(rep, "POST", `/api/v1/chat/leads/${lead}`)).json().id;
    const root = await say(rep, "She asked about price", conv);
    await say(rep, "And about timing", conv);
    await replied(admin, root.id, "Send her the sheet");
    const row = (await list(admin)).leads.find((c: { id: string }) => c.id === conv);
    expect(row).toMatchObject({ unread: 0 });
    expect((await list(rep)).threads.unread).toBe(1);
    await h.queryAll("UPDATE leads SET owner_id = $1 WHERE id = $2", [mate.id, lead]);
    expect((await list(rep)).threads.unread).toBe(0);
    expect(await followed(rep)).toEqual([]);
    expect((await as(rep, "GET", `/api/v1/chat/messages/${root.id}/thread`)).statusCode).toBe(404);
  });
});

describe("pages and events", () => {
  it("pages of 50, the first message among them, older and newer", async () => {
    const root = await say(rep, "Root");
    for (let i = 0; i < 55; i++) await replied(rep, root.id, `r${i}`);
    const first = await thread(mate, root.id);
    expect(first.messages).toHaveLength(50);
    expect(first.more).toBe(true);
    expect(first.messages.at(-1)!.body).toBe("r54");
    const older = await thread(mate, root.id, `?before=${first.messages[0]!.id}`);
    expect(bodies(older.messages)).toEqual(["Root", "r0", "r1", "r2", "r3", "r4"]);
    expect(older.more).toBe(false);
    const newer = await thread(mate, root.id, `?after=${older.messages.at(-1)!.id}`);
    expect(newer.messages.map((m) => m.id)).toEqual(first.messages.map((m) => m.id));
    expect((await thread(mate, root.id, `?after=${root.id - 1}`)).messages[0]!.id).toBe(root.id);
  });

  it("an event's thread is a whole number above zero, or the event is dropped", () => {
    const c = "0190e0c0-0000-7000-8000-00000000c0a1";
    const of = (t: unknown) => chatEventOf(JSON.stringify({ c, e: "reply", m: 5, t }));
    expect(of(4)).toEqual({ c, e: "reply", m: 5, t: 4 });
    for (const t of [0, -1, 1.5, "4", null, 2 ** 60]) expect(of(t)).toBeNull();
  });
});
