import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { ALL_GRANTS } from "@lume/core";
import { heldOpen } from "../../../test/held";
import { tuning } from "./conversations";

/** Team Chat's first review (2026-11-24): each finding on the server, held by a test. */
let h: Harness;
let base: string;
let boss: SeededUser;
let manager: SeededUser;
let rep: SeededUser;
let mate: SeededUser;
const use = { key: "chat.use", scope: null } as const;
const own = { key: "leads.view", scope: "own" } as const;

type M = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const as = async (u: SeededUser, method: M, url: string, payload?: Record<string, unknown>) =>
  (await h.signIn(u)).inject({ method, url, ...(payload ? { payload } : {}) });
const list = async (u: SeededUser) => (await as(u, "GET", "/api/v1/chat")).json();
const send = (u: SeededUser, conv: string, body: string) =>
  as(u, "POST", `/api/v1/chat/${conv}/messages`, { clientId: crypto.randomUUID(), body });
const page = (u: SeededUser, conv: string) => as(u, "GET", `/api/v1/chat/${conv}/messages`);
const channel = async (name: string, people: SeededUser[], groups: unknown[] = []) =>
  (
    await as(manager, "POST", "/api/v1/chat/channels", { name, people: people.map((p) => p.id), groups })
  ).json().id as string;
const inChannels = async (u: SeededUser) =>
  ((await list(u)).channels as { name: string }[]).map((c) => c.name);

beforeAll(async () => {
  h = await createHarness();
  boss = await h.seedUser({ name: "Maya Kapoor", grants: [use, { key: "leads.view", scope: "all" }] });
  manager = await h.seedUser({
    name: "Zoya Khan",
    grants: [use, { key: "chat.channels.manage", scope: null }],
  });
  rep = await h.seedUser({ name: "Rahul Mehta", grants: [use, own] });
  mate = await h.seedUser({ name: "Sana Iqbal", grants: [use, own] });
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.ownerPool.query("TRUNCATE chat_conversations, chat_files CASCADE");
});

describe("a lead's thread follows the lead, whatever anyone did there before", () => {
  it("someone who opened, read and wrote in it can do none of it once the lead moves away", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Priya Shah" });
    const t = (await as(rep, "POST", `/api/v1/chat/leads/${lead}`)).json().id;
    const mine = (await send(rep, t, "Booked Thursday")).json();
    await as(rep, "PUT", `/api/v1/chat/${t}/read`, { upTo: mine.id });
    await as(rep, "PUT", `/api/v1/chat/${t}/mute`, { muted: true });
    await h.queryAll("UPDATE leads SET owner_id = $1 WHERE id = $2 RETURNING id", [mate.id, lead]);
    expect((await page(rep, t)).statusCode).toBe(404);
    expect((await send(rep, t, "Still here?")).statusCode).toBe(404);
    expect((await as(rep, "GET", `/api/v1/chat/${t}`)).statusCode).toBe(404);
    expect((await as(rep, "PATCH", `/api/v1/chat/messages/${mine.id}`, { body: "Changed" })).statusCode).toBe(
      404,
    );
    expect((await as(rep, "DELETE", `/api/v1/chat/messages/${mine.id}`)).statusCode).toBe(404);
    const thumb = encodeURIComponent("👍");
    expect((await as(rep, "PUT", `/api/v1/chat/messages/${mine.id}/reactions/${thumb}`)).statusCode).toBe(
      404,
    );
    expect((await as(rep, "PUT", `/api/v1/chat/${t}/read`, { upTo: mine.id })).statusCode).toBe(404);
    expect((await as(rep, "POST", `/api/v1/chat/${t}/typing`)).statusCode).toBe(404);
    expect((await list(rep)).leads).toEqual([]);
    expect((await page(mate, t)).json().messages).toHaveLength(1);
  });

  it("a lead that has been talked about brings its thread to whoever it moves to, unread; one that hasn't, nothing", async () => {
    const [talked, quiet] = [
      await h.seedLead({ ownerId: rep.id, name: "Priya Shah" }),
      await h.seedLead({ ownerId: rep.id, name: "Meera Rao" }),
    ];
    const t = (await as(rep, "POST", `/api/v1/chat/leads/${talked}`)).json().id;
    await as(rep, "POST", `/api/v1/chat/leads/${quiet}`);
    await send(rep, t, "Wants two parts");
    await h.queryAll("UPDATE leads SET owner_id = $1 WHERE id = ANY($2) RETURNING id", [
      mate.id,
      [talked, quiet],
    ]);
    expect((await list(mate)).leads).toMatchObject([{ id: t, unread: 1 }]);
    // To no one, and back: nothing lost.
    await h.queryAll("UPDATE leads SET owner_id = NULL WHERE id = $1 RETURNING id", [talked]);
    expect((await list(mate)).leads).toEqual([]);
    await h.queryAll("UPDATE leads SET owner_id = $1 WHERE id = $2 RETURNING id", [mate.id, talked]);
    expect((await list(mate)).leads).toMatchObject([{ id: t, unread: 1 }]);
  });

  it("someone with thousands of threads has the same list, found the other way", async () => {
    const said: string[] = [];
    for (let i = 0; i < 4; i++) {
      const lead = await h.seedLead({ ownerId: i % 2 ? rep.id : mate.id, name: `Lead ${i}` });
      const t = (await as(boss, "POST", `/api/v1/chat/leads/${lead}`)).json().id;
      await send(boss, t, `About ${i}`);
      said.push(t);
    }
    const dm = (await as(rep, "POST", "/api/v1/chat/direct", { people: [mate.id] })).json().id;
    await send(mate, dm, "Hi");
    const few = await list(rep);
    expect(few.leads.map((l: { id: string }) => l.id)).toEqual([said[3], said[1]]);
    const before = { ...tuning };
    const ids = async (u: SeededUser) => (await list(u)).leads.map((l: { id: string }) => l.id);
    try {
      // As many as a list shows are found among the newest.
      Object.assign(tuning, { manyPlaces: 1, leadsShown: 2 });
      expect(await list(rep)).toEqual(few);
      expect(await ids(boss)).toEqual([said[3], said[2]]);
      // Too few of theirs among the newest: from their places after all.
      Object.assign(tuning, { newestThreads: 1 });
      expect(await list(rep)).toEqual(few);
      expect(await ids(mate)).toEqual([said[2], said[0]]);
    } finally {
      Object.assign(tuning, before);
    }
  });

  it("a deleted lead's thread is gone with it", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Kabir Das" });
    const t = (await as(rep, "POST", `/api/v1/chat/leads/${lead}`)).json().id;
    await send(rep, t, "Hi");
    await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1 RETURNING id", [lead]);
    expect((await page(rep, t)).statusCode).toBe(404);
    expect((await list(rep)).leads).toEqual([]);
    expect((await as(rep, "POST", `/api/v1/chat/leads/${lead}`)).statusCode).toBe(404);
  });

  it("seeing a thread, or a message reaching one's device, isn't following it; writing in it is", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Meera Rao" });
    const t = (await as(boss, "POST", `/api/v1/chat/leads/${lead}`)).json().id;
    // Opened and empty: in nobody's list.
    expect((await list(boss)).leads).toEqual([]);
    expect((await list(rep)).leads).toEqual([]);
    const m = (await send(rep, t, "Asked about two parts")).json();
    // Looked at, and no place kept: nothing there is new to them.
    expect((await page(boss, t)).json().lastReadId).toBeNull();
    expect((await page(rep, t)).json().lastReadId).toBe(m.id);
    await as(boss, "PUT", `/api/v1/chat/${t}/delivered`, { upTo: m.id });
    await as(boss, "PUT", `/api/v1/chat/${t}/read`, { upTo: m.id });
    expect((await list(boss)).leads).toEqual([]);
    await as(boss, "PUT", `/api/v1/chat/${t}/mute`, { muted: true });
    expect((await list(boss)).leads).toEqual([]);
    await send(boss, t, "Two parts is fine");
    expect((await list(boss)).leads).toMatchObject([{ id: t, unread: 0 }]);
    expect((await list(rep)).leads).toMatchObject([{ id: t, unread: 1 }]);
    await as(rep, "PUT", `/api/v1/chat/${t}/read`, { upTo: 9_000_000 });
    expect((await list(rep)).unread).toBe(0);
    // Never past the newest there is: the next one is unread.
    await send(boss, t, "And free this week");
    expect((await list(rep)).unread).toBe(1);
  });
});

describe("who is in a channel", () => {
  it("someone taken out while their tab marks it read stays out", async () => {
    const ch = await channel("sales", [rep, mate]);
    const m = (await send(rep, ch, "Morning")).json();
    const held = await heldOpen(h, manager.id, (c) =>
      c.query("DELETE FROM chat_members WHERE conversation_id = $1 AND user_id = $2", [ch, mate.id]),
    );
    const reading = as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: m.id });
    await held.commitOnceWaited();
    await reading;
    expect(await inChannels(mate)).toEqual([]);
    expect((await page(mate, ch)).statusCode).toBe(404);
  });

  it("the same people and groups again: nobody loses where they had read to, or their mute", async () => {
    const team = await h.seedTeam(manager.id, [mate.id]);
    const groups = [{ kind: "team", id: team }];
    const ch = await channel("floor", [rep], groups);
    await send(rep, ch, "One");
    await as(mate, "PUT", `/api/v1/chat/${ch}/mute`, { muted: true });
    const same = { people: [manager.id, rep.id], groups };
    expect((await as(manager, "PUT", `/api/v1/chat/channels/${ch}/members`, same)).statusCode).toBe(200);
    expect((await list(mate)).channels).toMatchObject([{ name: "floor", unread: 1, muted: true }]);
    // In by hand as well, then by the team alone: still the same place.
    await as(manager, "PUT", `/api/v1/chat/channels/${ch}/members`, {
      people: [manager.id, rep.id, mate.id],
      groups,
    });
    await as(manager, "PUT", `/api/v1/chat/channels/${ch}/members`, same);
    expect((await list(mate)).channels).toMatchObject([{ name: "floor", unread: 1, muted: true }]);
    // From the team to everyone in one go: never out in between.
    await as(manager, "PUT", `/api/v1/chat/channels/${ch}/members`, {
      people: [manager.id],
      groups: [{ kind: "everyone" }],
    });
    expect((await list(mate)).channels).toMatchObject([{ name: "floor", unread: 1, muted: true }]);
    await as(manager, "PUT", `/api/v1/chat/channels/${ch}/members`, { people: [manager.id], groups: [] });
    expect(await inChannels(mate)).toEqual([]);
    expect(await inChannels(rep)).toEqual([]);
  });

  it("a manager changes channels they aren't in, by name and people, and never reads what's said there", async () => {
    const ch = await channel("deals", [rep]);
    await send(rep, ch, "Secret price");
    await as(manager, "PUT", `/api/v1/chat/channels/${ch}/members`, { people: [rep.id], groups: [] });
    expect(await inChannels(manager)).toEqual([]);
    expect((await page(manager, ch)).statusCode).toBe(404);
    const all = await as(manager, "GET", "/api/v1/chat/channels");
    expect(all.json().channels).toMatchObject([
      { id: ch, name: "deals", archived: false, people: [rep.id], members: 1 },
    ]);
    expect(all.body).not.toContain("Secret");
    expect((await as(rep, "GET", "/api/v1/chat/channels")).statusCode).toBe(403);
    expect(
      (await as(manager, "PATCH", `/api/v1/chat/channels/${ch}`, { name: "big-deals" })).statusCode,
    ).toBe(200);
    expect(await inChannels(rep)).toEqual(["big-deals"]);
    // Archived: gone from lists, nothing more said or changed there; its name is free; back as it was.
    const m = (await send(rep, ch, "Last word")).json();
    await as(manager, "PATCH", `/api/v1/chat/channels/${ch}`, { archived: true });
    expect(await inChannels(rep)).toEqual([]);
    expect((await send(rep, ch, "Hello?")).statusCode).toBe(404);
    expect((await as(rep, "PATCH", `/api/v1/chat/messages/${m.id}`, { body: "Changed" })).statusCode).toBe(
      404,
    );
    expect((await as(rep, "DELETE", `/api/v1/chat/messages/${m.id}`)).statusCode).toBe(404);
    const party = encodeURIComponent("🎉");
    expect((await as(rep, "PUT", `/api/v1/chat/messages/${m.id}/reactions/${party}`)).statusCode).toBe(404);
    expect((await as(manager, "POST", "/api/v1/chat/channels", { name: "big-deals" })).statusCode).toBe(201);
    const back = await as(manager, "PATCH", `/api/v1/chat/channels/${ch}`, { archived: false });
    expect(back.statusCode).toBe(409);
    await as(manager, "PATCH", `/api/v1/chat/channels/${ch}`, { archived: false, name: "old-deals" });
    expect(await inChannels(rep)).toEqual(["old-deals"]);
    const none = crypto.randomUUID();
    expect((await as(manager, "PATCH", `/api/v1/chat/channels/${none}`, { name: "x" })).statusCode).toBe(404);
    for (const c of [none, (await as(rep, "POST", "/api/v1/chat/direct", { people: [mate.id] })).json().id])
      expect(
        (await as(manager, "PUT", `/api/v1/chat/channels/${c}/members`, { people: [boss.id], groups: [] }))
          .statusCode,
      ).toBe(404);
    const gone = await as(manager, "PUT", `/api/v1/chat/channels/${ch}/members`, {
      people: [],
      groups: [{ kind: "team", id: none }],
    });
    expect(gone.statusCode).toBe(400);
    expect(gone.json().error.message).toBe("That team or role isn't there any more.");
  });

  it("someone in by their team and by hand stays when the team goes", async () => {
    const team = await h.seedTeam(manager.id, [mate.id]);
    const ch = await channel("floor", [rep], [{ kind: "team", id: team }]);
    const put = (people: SeededUser[], groups: unknown[]) =>
      as(manager, "PUT", `/api/v1/chat/channels/${ch}/members`, { people: people.map((p) => p.id), groups });
    await put([manager, rep, mate], [{ kind: "team", id: team }]);
    await put([manager, rep, mate], []);
    expect(await inChannels(mate)).toEqual(["floor"]);
  });

  it("saving a team, or a person's roles, again: nobody loses where they had read to, or their mute", async () => {
    const owner = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Hana Ito" });
    const team = await h.seedTeam(rep.id, [mate.id]);
    const role = (
      await h.ownerPool.query("SELECT role_id AS id FROM user_roles WHERE user_id = $1", [mate.id])
    ).rows[0].id as string;
    const byTeam = await channel("floor", [], [{ kind: "team", id: team }]);
    const byRole = await channel("sellers", [], [{ kind: "role", id: role }]);
    for (const c of [byTeam, byRole]) {
      await send(manager, c, "One");
      await as(mate, "PUT", `/api/v1/chat/${c}/mute`, { muted: true });
    }
    const o = await h.signIn(owner);
    const members = [
      { userId: rep.id, isLead: true },
      { userId: mate.id, isLead: false },
      { userId: boss.id, isLead: false },
    ];
    const saved = await o.inject({
      method: "PUT",
      url: `/api/v1/teams/${team}/members`,
      payload: { members },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const roles = await o.inject({
      method: "PATCH",
      url: `/api/v1/users/${mate.id}`,
      payload: { roleIds: [role] },
    });
    expect(roles.statusCode, roles.body).toBeLessThan(300);
    expect((await list(mate)).channels).toMatchObject([
      { name: "floor", unread: 1, muted: true },
      { name: "sellers", unread: 1, muted: true },
    ]);
    // Someone who wasn't in starts from here: nothing said before is unread, and none of it is "new".
    expect((await list(boss)).channels).toMatchObject([{ name: "floor", unread: 0, muted: false }]);
    const p = (await page(boss, byTeam)).json();
    expect(p.messages).toHaveLength(1);
    expect(p.lastReadId).toBe(p.messages[0].id);
    await send(manager, byTeam, "Two");
    expect((await list(boss)).channels).toMatchObject([{ name: "floor", unread: 1 }]);
    // Added by hand, the same.
    await as(manager, "PUT", `/api/v1/chat/channels/${byRole}/members`, {
      people: [manager.id, boss.id],
      groups: [],
    });
    expect((await list(boss)).channels).toContainEqual(
      expect.objectContaining({ name: "sellers", unread: 0 }),
    );
    // A team deleted since isn't in the channel's groups any more.
    expect((await o.inject({ method: "DELETE", url: `/api/v1/teams/${team}` })).statusCode).toBe(204);
    const all = (await as(manager, "GET", "/api/v1/chat/channels")).json().channels;
    expect(all.find((c: { id: string }) => c.id === byTeam)).toMatchObject({ groups: [] });
  });

  it("names and photos of everyone who chats, for anyone who chats", async () => {
    const r = await as(manager, "GET", "/api/v1/chat/people");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().people).toContainEqual({
      id: rep.id,
      name: "Rahul Mehta",
      active: true,
      avatar: { color: null, version: 0, photo: false },
    });
    expect(r.body).not.toContain("@");
    await h.ownerPool.query(
      "INSERT INTO users (id, email, name, status) VALUES (gen_random_uuid(), 'soon@example.com', 'Not Here Yet', 'invited')",
    );
    expect((await as(manager, "GET", "/api/v1/chat/people")).body).not.toContain("Not Here Yet");
  });
});

describe("sends, marks and files", () => {
  it("Delivered is not Seen, and only a direct message has either for others", async () => {
    const dm = (await as(rep, "POST", "/api/v1/chat/direct", { people: [mate.id] })).json().id;
    const m = (await send(rep, dm, "There?")).json();
    await as(mate, "PUT", `/api/v1/chat/${dm}/delivered`, { upTo: m.id });
    const marks = (await page(rep, dm)).json().members.find((x: { userId: string }) => x.userId === mate.id);
    expect(marks).toEqual({ userId: mate.id, lastReadId: 0, lastDeliveredId: m.id });
    const ch = await channel("sales", [rep, mate]);
    const inCh = (await send(rep, ch, "All")).json();
    await as(mate, "PUT", `/api/v1/chat/${ch}/delivered`, { upTo: inCh.id });
    const kept = await h.queryAll<{ n: string }>(
      "SELECT last_delivered_id AS n FROM chat_members WHERE conversation_id = $1 AND user_id = $2",
      [ch, mate.id],
    );
    expect(Number(kept[0]!.n)).toBe(0);
    await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: inCh.id });
    const p = (await page(mate, ch)).json();
    expect(p.members).toEqual([]);
    expect(p.lastReadId).toBe(inCh.id);
  });

  it("a tick never waits for someone who has left", async () => {
    const gone = await h.seedUser({ name: "Old Person", grants: [use] });
    const dm = (await as(rep, "POST", "/api/v1/chat/direct", { people: [mate.id, gone.id] })).json().id;
    const m = (await send(rep, dm, "Both there?")).json();
    await h.ownerPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [gone.id]);
    await as(mate, "PUT", `/api/v1/chat/${dm}/read`, { upTo: m.id });
    const marks = (await page(rep, dm)).json().members as { userId: string }[];
    expect(marks.map((x) => x.userId).sort()).toEqual([rep.id, mate.id].sort());
  });

  it("the same file sent into two conversations at once goes with one of them", async () => {
    const [a, b] = [await channel("one", [rep]), await channel("two", [rep])];
    const file = (
      await (
        await h.signIn(rep)
      ).inject({
        method: "POST",
        url: "/api/v1/chat/files",
        headers: { "content-type": "application/octet-stream", "x-file-name": "p.png" },
        payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
      })
    ).json().file.id as string;
    const held = await heldOpen(h, rep.id, (c) =>
      c.query("SELECT 1 FROM chat_files WHERE id = $1 FOR UPDATE", [file]),
    );
    const go = (c: string) =>
      as(rep, "POST", `/api/v1/chat/${c}/messages`, { clientId: crypto.randomUUID(), files: [file] });
    const both = Promise.all([go(a), go(b)]);
    await held.commitOnceWaited();
    expect((await both).map((r) => r.statusCode).sort()).toEqual([201, 400]);
  });

  it("a send waits for the one before it in the conversation, so ids land in order", async () => {
    const ch = await channel("sales", [rep, mate]);
    const held = await heldOpen(h, mate.id, (c) =>
      c.query("SELECT 1 FROM chat_conversations WHERE id = $1 FOR NO KEY UPDATE", [ch]),
    );
    const second = send(rep, ch, "After");
    await held.commitOnceWaited();
    expect((await second).statusCode).toBe(201);
  });

  it("a page says whether there's more, and my own sends carry the id they were sent with", async () => {
    const ch = await channel("sales", [rep, mate]);
    for (let i = 0; i < 51; i++) await send(rep, ch, `m${i}`);
    const p = (await page(rep, ch)).json();
    expect(p).toMatchObject({ more: true });
    expect(p.messages[0].clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await page(mate, ch)).json().messages[0].clientId).toBeNull();
    const first = p.messages[0].id;
    expect((await as(rep, "GET", `/api/v1/chat/${ch}/messages?before=${first}`)).json()).toMatchObject({
      more: false,
    });
    expect((await list(mate)).channels[0].unread).toBe(51);
    for (let i = 0; i < 60; i++) await send(rep, ch, `n${i}`);
    expect((await as(mate, "GET", "/api/v1/chat/unread")).json()).toEqual({ unread: 100, muted: [] });
    await as(mate, "PUT", `/api/v1/chat/${ch}/mute`, { muted: true });
    expect((await as(mate, "GET", "/api/v1/chat/unread")).json()).toEqual({ unread: 0, muted: [ch] });
  }, 60_000);

  it("typing, marks and reactions keep no row to be remembered by", async () => {
    const ch = await channel("sales", [rep, mate]);
    const m = (await send(rep, ch, "Hi")).json();
    const keys = async () =>
      Number((await h.ownerPool.query("SELECT count(*) AS n FROM idempotency_keys")).rows[0].n);
    const c = await h.signIn(mate);
    const before = await keys();
    for (const [method, url, payload] of [
      ["POST", `/api/v1/chat/${ch}/typing`, undefined],
      ["PUT", `/api/v1/chat/${ch}/read`, { upTo: m.id }],
      ["PUT", `/api/v1/chat/${ch}/delivered`, { upTo: m.id }],
      ["PUT", `/api/v1/chat/messages/${m.id}/reactions/${encodeURIComponent("👍")}`, undefined],
    ] as const)
      expect(
        (
          await c.inject({
            method,
            url,
            headers: { "idempotency-key": crypto.randomUUID() },
            ...(payload ? { payload } : {}),
          })
        ).statusCode,
      ).toBe(204);
    expect(await keys()).toBe(before);
  });

  it("a file nobody sent is let go after a day; one that was sent, or is newer, stays", async () => {
    const ch = await channel("sales", [rep]);
    const up = async (name: string) =>
      (
        await (
          await h.signIn(rep)
        ).inject({
          method: "POST",
          url: "/api/v1/chat/files",
          headers: { "content-type": "application/octet-stream", "x-file-name": name },
          payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
        })
      ).json().file.id as string;
    const [sent, left, fresh] = [await up("sent.png"), await up("left.png"), await up("fresh.png")];
    await as(rep, "POST", `/api/v1/chat/${ch}/messages`, { clientId: crypto.randomUUID(), files: [sent] });
    await h.ownerPool.query(
      "UPDATE chat_files SET created_at = now() - interval '2 days' WHERE id = ANY($1)",
      [[sent, left]],
    );
    const n = await h.pool.query("SELECT lume_chat_forget_files(now() - interval '1 day') AS n");
    expect(Number(n.rows[0].n)).toBe(1);
    const open = async (id: string) => (await as(rep, "GET", `/api/v1/chat/files/${id}`)).statusCode;
    expect([await open(sent), await open(left), await open(fresh)]).toEqual([200, 404, 200]);
  });
});

describe("what the stream says of marks", () => {
  const cookie = (c: AuthedClient) =>
    Object.entries(c.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  async function heard(u: SeededUser, act: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
    const c = await h.signIn(u);
    const ac = new AbortController();
    const res = await fetch(`${base}/api/v1/stream`, { headers: { cookie: cookie(c) }, signal: ac.signal });
    let buf = "";
    const reader = res.body!.getReader();
    const reading = (async () => {
      const text = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += text.decode(value);
        }
      } catch {
        // aborted
      }
    })();
    await new Promise((r) => setTimeout(r, 150));
    await act();
    await new Promise((r) => setTimeout(r, 900));
    ac.abort();
    await reading;
    return [...buf.matchAll(/^event: chat\ndata: (.*)$/gm)].map((x) => JSON.parse(x[1]!));
  }

  it("a read in a channel is told to that person's own tabs; in a direct message to the other too", async () => {
    const ch = await channel("sales", [rep, mate]);
    const dm = (await as(rep, "POST", "/api/v1/chat/direct", { people: [mate.id] })).json().id;
    const [a, b] = [(await send(rep, ch, "All")).json(), (await send(rep, dm, "You")).json()];
    const act = async () => {
      await as(mate, "PUT", `/api/v1/chat/${ch}/read`, { upTo: a.id });
      await as(mate, "PUT", `/api/v1/chat/${dm}/delivered`, { upTo: b.id });
      // Past the end: said as it was kept. The same again moves nothing, and says nothing.
      await as(mate, "PUT", `/api/v1/chat/${dm}/read`, { upTo: 9_000_000 });
      await as(mate, "PUT", `/api/v1/chat/${dm}/read`, { upTo: 9_000_000 });
      await as(mate, "PUT", `/api/v1/chat/${dm}/delivered`, { upTo: 9_000_000 });
    };
    const theirs = heard(mate, async () => new Promise((r) => setTimeout(r, 700)));
    const others = await heard(rep, act);
    expect(others).toEqual([
      { c: dm, e: "delivered", m: b.id, u: mate.id, d: true },
      { c: dm, e: "read", m: b.id, u: mate.id, d: true },
    ]);
    expect(await theirs).toContainEqual({ c: ch, e: "read", m: a.id, u: mate.id });
  });
});
