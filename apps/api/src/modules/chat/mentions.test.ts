import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { noticeTuning, noticesSettled } from "./notices";

/** Team Chat's mentions and what the bell says (plan 2026-11-25-team-chat-2b, Task 2). */
let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
let mate: SeededUser;
let outsider: SeededUser;
let ch: string;

const real = { ...noticeTuning };
/** How long a notice waits (null: as it does for people). */
const waits = (ms: number | null) =>
  Object.assign(noticeTuning, ms === null ? real : { direct: ms, mention: ms });

type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const as = async (u: SeededUser, method: M, url: string, payload?: Record<string, unknown>) =>
  (await h.signIn(u)).inject({ method, url, ...(payload ? { payload } : {}) });
const at = (u: SeededUser | string) => `<@${typeof u === "string" ? u : u.id}>`;
const send = (u: SeededUser, body: string, conv = ch, more: Record<string, unknown> = {}) =>
  as(u, "POST", `/api/v1/chat/${conv}/messages`, { clientId: crypto.randomUUID(), body, ...more });
const said = async (u: SeededUser, body: string, conv = ch) => {
  const r = await send(u, body, conv);
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: number; notTold?: string[] };
};
type Note = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  read: boolean;
  leadId: string | null;
  chat?: { conversation: string; thread: number | null };
};
/** What the bell holds once everything waiting has been written. */
const bell = async (u: SeededUser): Promise<Note[]> => {
  await new Promise((r) => setTimeout(r, 150));
  await noticesSettled();
  return (await as(u, "GET", "/api/v1/notifications")).json().items;
};
const unread = async (u: SeededUser) => (await bell(u)).filter((n) => !n.read).map((n) => n.title);
const direct = async (a: SeededUser, ...b: SeededUser[]) =>
  (await as(a, "POST", "/api/v1/chat/direct", { people: b.map((x) => x.id) })).json().id as string;
const use = { key: "chat.use", scope: null } as const;
const own = { key: "leads.view", scope: "own" } as const;

beforeAll(async () => {
  waits(40);
  h = await createHarness();
  admin = await h.seedUser({
    name: "Maya Kapoor",
    grants: [use, { key: "chat.channels.manage", scope: null }, { key: "leads.view", scope: "all" }],
  });
  rep = await h.seedUser({ name: "Rahul Mehta", grants: [use, own] });
  mate = await h.seedUser({ name: "Sana Iqbal", grants: [use, own] });
  outsider = await h.seedUser({ name: "Arjun Nair", grants: [use, own] });
});
afterAll(async () => {
  waits(null);
  await h.close();
});
beforeEach(async () => {
  await h.ownerPool.query("TRUNCATE chat_conversations CASCADE");
  ch = (await as(admin, "POST", "/api/v1/chat/channels", { name: "sales", people: [rep.id, mate.id] })).json()
    .id;
});

describe("who is told", () => {
  it("someone named by name is told who and where, and never what was said", async () => {
    const m = await said(rep, `${at(mate)} call +91 98765 43210 about sam@example.com`);
    expect(m.notTold).toBeUndefined();
    const [n] = await bell(mate);
    expect(n).toMatchObject({
      kind: "chat_mention",
      title: "Rahul Mehta mentioned you in #sales",
      body: null,
      read: false,
      chat: { conversation: ch, thread: null },
    });
    expect(JSON.stringify(n)).not.toMatch(/98765|example\.com/);
    expect(await bell(rep)).toEqual([]);
    expect(await bell(admin)).toEqual([]);
  });

  it("someone who can't read it is told nothing, and the sender hears whom", async () => {
    const gone = await h.seedUser({ name: "Left Us", grants: [use] });
    await h.ownerPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [gone.id]);
    const m = await said(rep, `${at(outsider)} ${at(gone)} ${at(mate)} ${at(crypto.randomUUID())}`);
    expect(m.notTold).toHaveLength(3);
    expect(m.notTold).toEqual(expect.arrayContaining([outsider.id, gone.id]));
    expect(await bell(outsider)).toEqual([]);
    expect(await unread(mate)).toHaveLength(1);
  });

  it("a member who was disabled is told nothing, and named among those who weren't", async () => {
    const gone = await h.seedUser({ name: "Off Now", grants: [use] });
    await as(admin, "PUT", `/api/v1/chat/channels/${ch}/members`, {
      people: [admin.id, rep.id, mate.id, gone.id],
      groups: [],
    });
    await h.ownerPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [gone.id]);
    expect((await said(rep, `${at(gone)} hi`)).notTold).toEqual([gone.id]);
    await h.ownerPool.query("UPDATE users SET status = 'active' WHERE id = $1", [gone.id]);
    expect(await bell(gone)).toEqual([]);
  });

  it("never oneself, and the same send twice tells once", async () => {
    const clientId = crypto.randomUUID();
    const body = `${at(rep)} ${at(mate)}`;
    const one = await send(rep, body, ch, { clientId });
    const two = await send(rep, body, ch, { clientId });
    expect([one.statusCode, two.statusCode]).toEqual([201, 200]);
    expect(one.json().notTold).toBeUndefined();
    expect(await bell(rep)).toEqual([]);
    expect(await unread(mate)).toEqual(["Rahul Mehta mentioned you in #sales"]);
  });

  it("a team's people, each once, whoever is also named; a deleted team's nobody", async () => {
    const team = await h.seedTeam(admin.id, [mate.id, outsider.id]);
    const m = await said(rep, `<@team:${team}> and ${at(mate)}`);
    // In the team but not in the channel: not named one by one, so nothing to say of them.
    expect(m.notTold).toBeUndefined();
    expect(await unread(mate)).toHaveLength(1);
    expect(await unread(admin)).toHaveLength(1);
    expect(await bell(outsider)).toEqual([]);
    await h.ownerPool.query("UPDATE teams SET deleted_at = now() WHERE id = $1", [team]);
    await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: m.id });
    await said(rep, `<@team:${team}> again`);
    expect(await unread(mate)).toEqual([]);
  });

  it("everyone in the channel; past fifty people only someone who manages channels may", async () => {
    await said(rep, "<@channel> standup");
    expect(await unread(mate)).toEqual(["Rahul Mehta mentioned you in #sales"]);
    await h.ownerPool.query(
      `WITH u AS (INSERT INTO users (id, email, name, status)
         SELECT gen_random_uuid(), 'many' || g || '@example.com', 'P' || g, 'active' FROM generate_series(1, 48) g RETURNING id)
       INSERT INTO chat_members (conversation_id, user_id) SELECT $1, id FROM u`,
      [ch],
    );
    const no = await send(rep, "<@channel> standup");
    expect(no.statusCode).toBe(400);
    expect(no.json().error.message).toBe(
      "In a channel of more than 50 people, only someone who manages channels can name everyone.",
    );
    expect((await as(rep, "GET", `/api/v1/chat/${ch}/mentionable`)).json().everyone).toBe(false);
    expect((await send(admin, "<@channel> standup")).statusCode).toBe(201);
    expect((await as(admin, "GET", `/api/v1/chat/${ch}/mentionable`)).json().everyone).toBe(true);
    await h.ownerPool.query("DELETE FROM users WHERE email LIKE 'many%'");
  });

  it("at most fifty named in one message", async () => {
    const many = (n: number) => Array.from({ length: n }, () => at(crypto.randomUUID())).join("");
    expect((await send(rep, many(51))).json().error.message).toBe(
      "A message can name at most 50 people and teams.",
    );
    expect((await send(rep, many(50))).statusCode).toBe(201);
  });

  it("about a lead: only who may see it now; naming them there lets them follow it from that message", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Asha Rao" });
    const conv = (await as(rep, "POST", `/api/v1/chat/leads/${lead}`)).json().id;
    await said(rep, "First words", conv);
    const m = await said(rep, `${at(admin)} ${at(mate)} look`, conv);
    expect(m.notTold).toEqual([mate.id]);
    expect(await bell(mate)).toEqual([]);
    const [n] = await bell(admin);
    expect(n).toMatchObject({ title: "Rahul Mehta mentioned you about Asha Rao", leadId: lead });
    const row = (await as(admin, "GET", "/api/v1/chat"))
      .json()
      .leads.find((c: { id: string }) => c.id === conv);
    expect(row.unread).toBe(1);
    // Someone who doesn't chat sees the lead and still isn't told.
    const silent = await h.seedUser({ name: "No Chat", grants: [{ key: "leads.view", scope: "all" }] });
    expect((await said(rep, at(silent), conv)).notTold).toEqual([silent.id]);
  });

  it("naming oneself about a lead tells nobody", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Mira Sen" });
    const conv = (await as(rep, "POST", `/api/v1/chat/leads/${lead}`)).json().id;
    expect((await said(rep, `${at(rep)} note to self`, conv)).notTold).toBeUndefined();
    expect(await bell(rep)).toEqual([]);
  });

  it("a deletion and a new mention waiting together: the new one is told", async () => {
    waits(400);
    try {
      const a = await said(rep, at(mate));
      await new Promise((r) => setTimeout(r, 600));
      await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: a.id });
      expect(await unread(mate)).toEqual([]);
      await as(rep, "DELETE", `/api/v1/chat/messages/${a.id}`);
      await said(rep, `${at(mate)} again`);
      await new Promise((r) => setTimeout(r, 700));
      expect(await unread(mate)).toEqual(["Rahul Mehta mentioned you in #sales"]);
    } finally {
      waits(40);
    }
  });

  it("a lead that moves away before the notice is written: nothing is said", async () => {
    const boss = await h.seedUser({ name: "Team Lead", grants: [use, { key: "leads.view", scope: "team" }] });
    await h.seedTeam(boss.id, [rep.id]);
    const lead = await h.seedLead({ ownerId: rep.id, name: "Kabir Das" });
    const conv = (await as(rep, "POST", `/api/v1/chat/leads/${lead}`)).json().id;
    waits(400);
    try {
      expect((await said(rep, at(boss), conv)).notTold).toBeUndefined();
      await h.queryAll("UPDATE leads SET owner_id = $1 WHERE id = $2", [outsider.id, lead]);
      await new Promise((r) => setTimeout(r, 500));
      expect(await bell(boss)).toEqual([]);
    } finally {
      waits(40);
    }
  });
});

describe("one line for each", () => {
  it("forty direct messages are one line that counts; reading the conversation clears it, anywhere", async () => {
    const dm = await direct(rep, mate);
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await said(rep, `m${i}`, dm)).id;
    expect(await unread(mate)).toEqual(["40 new messages from Rahul Mehta"]);
    expect(await bell(rep)).toEqual([]);
    await as(mate, "PUT", `/api/v1/chat/${dm}/read`, { upTo: last });
    expect(await unread(mate)).toEqual([]);
    expect((await as(mate, "GET", "/api/v1/notifications")).json().unread).toBe(0);
    await said(rep, "One more", dm);
    expect(await unread(mate)).toEqual(["New message from Rahul Mehta"]);
  });

  it("read while it waits: nothing is ever said", async () => {
    const dm = await direct(rep, mate);
    waits(300);
    try {
      const m = await said(rep, "Looking?", dm);
      await as(mate, "PUT", `/api/v1/chat/${dm}/read`, { upTo: m.id });
      await new Promise((r) => setTimeout(r, 400));
      expect(await bell(mate)).toEqual([]);
    } finally {
      waits(40);
    }
  });

  it("read up to an earlier message, what came after still counts", async () => {
    const a = await said(rep, at(mate));
    await said(rep, at(mate));
    expect(await unread(mate)).toEqual(["You were mentioned 2 times in #sales"]);
    await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: a.id });
    expect(await unread(mate)).toHaveLength(1);
  });

  it("a direct message's thread is its own: its replies aren't counted as new messages", async () => {
    const dm = await direct(rep, mate);
    const root = await said(rep, "Root", dm);
    await as(mate, "PUT", `/api/v1/chat/${dm}/read`, { upTo: root.id });
    await as(mate, "POST", "/api/v1/notifications/read", { all: true });
    await as(rep, "POST", `/api/v1/chat/messages/${root.id}/thread`, {
      clientId: crypto.randomUUID(),
      body: "In it",
    });
    await said(rep, "Out here", dm);
    expect(await unread(mate)).toEqual(["New message from Rahul Mehta"]);
  });

  it("a group says so, and a name in a direct message is one line, not two", async () => {
    const dm = await direct(rep, mate, admin);
    await said(rep, `${at(mate)} hi`, dm);
    expect(await unread(mate)).toEqual(["New message from Rahul Mehta in your group"]);
    await said(admin, "hello", dm);
    expect(await unread(mate)).toEqual(["2 new messages in your group, the last from Maya Kapoor"]);
  });

  it("a deleted message takes its notice back, or leaves the rest", async () => {
    const a = await said(rep, at(mate));
    const b = await said(rep, at(mate));
    expect(await unread(mate)).toEqual(["You were mentioned 2 times in #sales"]);
    await as(rep, "DELETE", `/api/v1/chat/messages/${a.id}`);
    expect(await unread(mate)).toEqual(["Rahul Mehta mentioned you in #sales"]);
    await as(rep, "DELETE", `/api/v1/chat/messages/${b.id}`);
    expect(await bell(mate)).toEqual([]);
    const dm = await direct(rep, mate);
    const d = await said(rep, "Oops", dm);
    expect(await unread(mate)).toHaveLength(1);
    await as(rep, "DELETE", `/api/v1/chat/messages/${d.id}`);
    expect(await unread(mate)).toEqual([]);
  });

  it("edited to add a name tells them, read or not; edited to take it away un-tells nobody", async () => {
    const m = await said(rep, "Look at this");
    // They had read it: the name is new to them all the same.
    await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: m.id });
    const edit = (body: string) => as(rep, "PATCH", `/api/v1/chat/messages/${m.id}`, { body });
    const e = await edit(`${at(mate)} ${at(outsider)} look at this`);
    expect(e.json().notTold).toEqual([outsider.id]);
    expect(await unread(mate)).toEqual(["Rahul Mehta mentioned you in #sales"]);
    await edit("Look at this");
    expect(await unread(mate)).toHaveLength(1);
    // Nor are they told twice by naming them again.
    await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: m.id });
    expect(await unread(mate)).toEqual([]);
    await edit(`${at(mate)} again`);
    expect(await unread(mate)).toEqual([]);
  });

  it("in a thread: its own line, which opens the thread, settled by reading the thread; and it's theirs to follow", async () => {
    const root = await said(rep, "Root");
    const url = `/api/v1/chat/messages/${root.id}/thread`;
    const r = await as(rep, "POST", url, { clientId: crypto.randomUUID(), body: at(mate) });
    expect(r.statusCode).toBe(201);
    const [n] = await bell(mate);
    expect(n).toMatchObject({ kind: "chat_mention", chat: { conversation: ch, thread: root.id } });
    expect((await as(mate, "GET", "/api/v1/chat")).json().threads).toEqual({ any: true, unread: 1 });
    await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: r.json().id });
    expect(await unread(mate)).toHaveLength(1);
    await as(mate, "PUT", `${url}/read`, { upTo: r.json().id });
    expect(await unread(mate)).toEqual([]);
    // Also sent: it is the conversation's, and one line there.
    await as(rep, "POST", url, { clientId: crypto.randomUUID(), body: at(mate), alsoSend: true });
    expect((await bell(mate)).filter((x) => !x.read)[0]).toMatchObject({
      chat: { conversation: ch, thread: null },
    });
  });

  it("someone who stopped following a thread follows it again by name, not through everyone", async () => {
    const root = await said(mate, "Root");
    const url = `/api/v1/chat/messages/${root.id}/thread`;
    const reply = (body: string) => as(rep, "POST", url, { clientId: crypto.randomUUID(), body });
    await reply("One");
    await as(mate, "PUT", `${url}/following`, { on: false });
    await reply("<@channel> two");
    expect((await as(mate, "GET", url)).json().following).toBe(false);
    await reply(`${at(mate)} three`);
    expect((await as(mate, "GET", url)).json().following).toBe(true);
    // From this message on: what was said while they weren't following it isn't waiting.
    expect((await as(mate, "GET", "/api/v1/chat")).json().threads.unread).toBe(1);
  });
});

describe("what the review found (2026-11-25)", () => {
  it("named through everyone, then by name in an edit: told by name after all, muted or not", async () => {
    await as(mate, "PUT", `/api/v1/chat/${ch}/mute`, { muted: true });
    const m = await said(rep, "<@channel> look");
    expect(await bell(mate)).toEqual([]);
    await as(rep, "PATCH", `/api/v1/chat/messages/${m.id}`, { body: `<@channel> ${at(mate)} look` });
    expect(await unread(mate)).toEqual(["Rahul Mehta mentioned you in #sales"]);
  });

  it("a typo in an old message that names everyone is put right, however big the channel is now", async () => {
    const m = await said(rep, "<@channel> standupp");
    await h.ownerPool.query(
      `WITH u AS (INSERT INTO users (id, email, name, status)
         SELECT gen_random_uuid(), 'big' || g || '@example.com', 'P' || g, 'active' FROM generate_series(1, 60) g RETURNING id)
       INSERT INTO chat_members (conversation_id, user_id) SELECT $1, id FROM u`,
      [ch],
    );
    const edit = (body: string) => as(rep, "PATCH", `/api/v1/chat/messages/${m.id}`, { body });
    expect((await edit("<@channel> standup")).statusCode).toBe(200);
    const other = await said(rep, "Standup");
    expect(
      (await as(rep, "PATCH", `/api/v1/chat/messages/${other.id}`, { body: "<@channel> standup" }))
        .statusCode,
    ).toBe(400);
    await h.ownerPool.query("DELETE FROM users WHERE email LIKE 'big%'");
  });

  it("the same send again says again who wasn't told", async () => {
    const clientId = crypto.randomUUID();
    const body = `${at(outsider)} hi`;
    const one = await send(rep, body, ch, { clientId });
    const two = await send(rep, body, ch, { clientId });
    expect([one.json().notTold, two.json().notTold]).toEqual([[outsider.id], [outsider.id]]);
  });

  it("deleting one of two in a direct message makes no line of its own; a line read stays read", async () => {
    const dm = await direct(rep, mate);
    const a = await said(rep, `${at(mate)} one`, dm);
    await said(rep, `${at(mate)} two`, dm);
    expect(await unread(mate)).toEqual(["2 new messages from Rahul Mehta"]);
    await as(rep, "DELETE", `/api/v1/chat/messages/${a.id}`);
    expect(await unread(mate)).toEqual(["New message from Rahul Mehta"]);
    const b = await said(rep, at(mate));
    await said(rep, at(mate));
    await bell(mate);
    await as(mate, "POST", "/api/v1/notifications/read", { all: true });
    await as(rep, "DELETE", `/api/v1/chat/messages/${b.id}`);
    expect(await unread(mate)).toEqual([]);
  });

  it("an edit that names someone in an old reply: their place in the thread clears by reading it", async () => {
    const root = await said(rep, "Root");
    const url = `/api/v1/chat/messages/${root.id}/thread`;
    const reply = async (body: string) =>
      (await as(rep, "POST", url, { clientId: crypto.randomUUID(), body })).json() as { id: number };
    const first = await reply("One");
    await reply("Two");
    const last = await reply("Three");
    await as(rep, "PATCH", `/api/v1/chat/messages/${first.id}`, { body: `One ${at(mate)}` });
    expect((await as(mate, "GET", "/api/v1/chat/threads")).json().threads[0].unread).toBe(3);
    await as(mate, "PUT", `${url}/read`, { upTo: last.id });
    expect((await as(mate, "GET", "/api/v1/chat/threads")).json().threads[0].unread).toBe(0);
    expect((await as(mate, "GET", "/api/v1/chat")).json().threads.unread).toBe(0);
    expect(await unread(mate)).toEqual([]);
  });

  it("a team or everyone named in a thread is told, and not made to follow it", async () => {
    const root = await said(rep, "Root");
    const url = `/api/v1/chat/messages/${root.id}/thread`;
    await as(rep, "POST", url, { clientId: crypto.randomUUID(), body: "<@channel> here" });
    expect(await unread(mate)).toEqual(["Rahul Mehta mentioned you in #sales"]);
    expect((await as(mate, "GET", "/api/v1/chat")).json().threads.any).toBe(false);
  });

  it("whom a message names is kept where it was said, and nowhere else", async () => {
    const m = await said(rep, at(mate));
    const c = await h.ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('lume.user_id', $1, true)", [mate.id]);
      const got = await c.query(
        "SELECT user_id, by_name, root::int AS root, seen FROM chat_mentions WHERE message_id = $1 AND conversation_id = $2",
        [m.id, ch],
      );
      expect(got.rows).toEqual([{ user_id: mate.id, by_name: true, root: 0, seen: false }]);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("a thousand named at once are written a few at a time, every one", async () => {
    await h.ownerPool.query(
      `WITH u AS (INSERT INTO users (id, email, name, status)
         SELECT gen_random_uuid(), 'crowd' || g || '@example.com', 'C' || g, 'active' FROM generate_series(1, 300) g RETURNING id),
       r AS (INSERT INTO user_roles (user_id, role_id)
         SELECT u.id, (SELECT role_id FROM user_roles WHERE user_id = $2 LIMIT 1) FROM u)
       INSERT INTO chat_members (conversation_id, user_id) SELECT $1, id FROM u`,
      [ch, rep.id],
    );
    const t0 = performance.now();
    expect((await send(admin, "<@channel> hello")).statusCode).toBe(201);
    // Everyone else's requests go on meanwhile.
    await new Promise((r) => setTimeout(r, 80));
    const t1 = performance.now();
    expect((await as(rep, "GET", "/api/v1/chat")).statusCode).toBe(200);
    expect(performance.now() - t1).toBeLessThan(1500);
    // Each person's bell is theirs alone: asked as each of them.
    const ids = (
      await h.ownerPool.query<{ id: string }>(
        "SELECT user_id AS id FROM chat_members WHERE conversation_id = $1",
        [ch],
      )
    ).rows.map((r) => r.id);
    const count = async () => {
      const c = await h.ownerPool.connect();
      let n = 0;
      try {
        for (const id of ids) {
          await c.query("SELECT set_config('lume.user_id', $1, false)", [id]);
          n += (
            await c.query("SELECT 1 FROM notifications WHERE user_id = $1 AND conversation_id = $2", [id, ch])
          ).rows.length;
        }
      } finally {
        await c.query("SELECT set_config('lume.user_id', '', false)");
        c.release();
      }
      return n;
    };
    while ((await count()) < 302 && performance.now() - t0 < 30_000)
      await new Promise((r) => setTimeout(r, 100));
    expect(await count()).toBe(302);
    await h.ownerPool.query("DELETE FROM users WHERE email LIKE 'crowd%'");
  }, 60_000);
});

describe("what people choose", () => {
  it("muted: no direct message, no everyone, no team; their own name still", async () => {
    const dm = await direct(rep, mate);
    await as(mate, "PUT", `/api/v1/chat/${dm}/mute`, { muted: true });
    await as(mate, "PUT", `/api/v1/chat/${ch}/mute`, { muted: true });
    await said(rep, "Hi", dm);
    await said(rep, "<@channel> hi");
    expect(await bell(mate)).toEqual([]);
    await said(rep, `${at(mate)} hi`);
    expect(await unread(mate)).toEqual(["Rahul Mehta mentioned you in #sales"]);
    await as(mate, "POST", "/api/v1/notifications/read", { all: true });
    await said(rep, `${at(mate)} hi`, dm);
    expect(await unread(mate)).toEqual(["Rahul Mehta mentioned you in a direct message"]);
  });

  it("switched off in My account: each alone", async () => {
    const prefs = (alerts: Record<string, boolean>) =>
      h.ownerPool.query(
        "UPDATE users SET preferences = jsonb_build_object('alerts', $2::jsonb) WHERE id = $1",
        [mate.id, JSON.stringify({ assigned: true, dueFollowUps: true, emailDigest: true, ...alerts })],
      );
    const dm = await direct(rep, mate);
    await prefs({ chatDirect: false });
    await said(rep, "Hi", dm);
    await said(rep, at(mate));
    expect(await unread(mate)).toEqual(["Rahul Mehta mentioned you in #sales"]);
    await as(mate, "POST", "/api/v1/notifications/read", { all: true });
    // Direct messages off: their own name in one still tells.
    await said(rep, `${at(mate)} hi`, dm);
    expect(await unread(mate)).toEqual(["Rahul Mehta mentioned you in a direct message"]);
    await as(mate, "POST", "/api/v1/notifications/read", { all: true });
    await prefs({ chatMentions: false });
    await said(rep, at(mate));
    await said(rep, "Hi again", dm);
    expect(await unread(mate)).toEqual(["3 new messages from Rahul Mehta"]);
    await h.ownerPool.query("UPDATE users SET preferences = '{}' WHERE id = $1", [mate.id]);
  });

  it("taken out of the channel, or no longer chatting, before it's written: nothing", async () => {
    waits(300);
    try {
      await said(rep, at(mate));
      await as(admin, "PUT", `/api/v1/chat/channels/${ch}/members`, {
        people: [admin.id, rep.id],
        groups: [],
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(await bell(mate)).toEqual([]);
    } finally {
      waits(40);
    }
  });
});

describe("whom one may name", () => {
  it("a channel's members, and teams by name alone; nothing to someone outside it", async () => {
    const team = await h.seedTeam(admin.id, [mate.id]);
    const got = (await as(rep, "GET", `/api/v1/chat/${ch}/mentionable`)).json();
    expect(new Set(got.members)).toEqual(new Set([admin.id, rep.id, mate.id]));
    expect(got.teams.find((t: { id: string }) => t.id === team)).toEqual({
      id: team,
      name: expect.any(String),
    });
    expect((await as(outsider, "GET", `/api/v1/chat/${ch}/mentionable`)).statusCode).toBe(404);
    const lead = await h.seedLead({ ownerId: rep.id, name: "Asha Rao" });
    const conv = (await as(rep, "POST", `/api/v1/chat/leads/${lead}`)).json().id;
    expect((await as(rep, "GET", `/api/v1/chat/${conv}/mentionable`)).json()).toMatchObject({
      members: null,
      everyone: true,
    });
  });
});
