import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { chatEventOf } from "../notifications/hub";
import { spacingMs } from "./live";

/** Team Chat, live (plan 2026-11-24-team-chat-2a, Task 6): who hears what on the stream, typing, online. */
let h: Harness;
let base: string;
let admin: SeededUser;
let rep: SeededUser;
let mate: SeededUser;
let outsider: SeededUser;
let ch: string;
const use = { key: "chat.use", scope: null } as const;

const cookie = (c: AuthedClient) =>
  Object.entries(c.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
type Heard = { event: string; data: Record<string, unknown> };

/** What a person's stream says while `act` runs, and a little after (a window, not a count: silence is an answer). */
async function heard(u: SeededUser, act: () => Promise<unknown>, ms = 1200): Promise<Heard[]> {
  const c = await h.signIn(u);
  const ac = new AbortController();
  const res = await fetch(`${base}/api/v1/stream`, { headers: { cookie: cookie(c) }, signal: ac.signal });
  const out: Heard[] = [];
  const reader = res.body!.getReader();
  const text = new TextDecoder();
  let buf = "";
  const reading = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += text.decode(value);
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if ((event === "chat" || event === "presence") && data) out.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  // The stream is open (its first bytes came) before anything is done.
  await new Promise((r) => setTimeout(r, 150));
  await act();
  await new Promise((r) => setTimeout(r, ms));
  ac.abort();
  await reading;
  return out;
}
const as = async (u: SeededUser, method: "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
  (await h.signIn(u)).inject({ method, url, ...(payload ? { payload } : {}) });
const send = (u: SeededUser, conv: string, body: string) =>
  as(u, "POST", `/api/v1/chat/${conv}/messages`, { clientId: crypto.randomUUID(), body });
const messages = (hs: Heard[], c: string) =>
  hs.filter((x) => x.event === "chat" && x.data.e === "message" && x.data.c === c);

beforeAll(async () => {
  h = await createHarness();
  admin = await h.seedUser({
    name: "Maya Kapoor",
    grants: [use, { key: "chat.channels.manage", scope: null }, { key: "leads.view", scope: "all" }],
  });
  rep = await h.seedUser({ name: "Rahul Mehta", grants: [use, { key: "leads.view", scope: "own" }] });
  mate = await h.seedUser({ name: "Sana Iqbal", grants: [use, { key: "leads.view", scope: "own" }] });
  outsider = await h.seedUser({ name: "Arjun Nair", grants: [use, { key: "leads.view", scope: "own" }] });
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.ownerPool.query("TRUNCATE chat_conversations CASCADE");
  ch = (await as(admin, "POST", "/api/v1/chat/channels", { name: "sales", people: [rep.id, mate.id] })).json()
    .id;
});

describe("the stream", () => {
  it("a message reaches every member's open stream once, and no one else's", async () => {
    const theirs = heard(outsider, async () => undefined, 1500);
    const mine = await heard(mate, () => send(rep, ch, "Booked Thursday"));
    const m = messages(mine, ch);
    expect(m).toHaveLength(1);
    expect(m[0]!.data).toEqual({ c: ch, e: "message", m: expect.any(Number), u: rep.id });
    const dm = (await as(rep, "POST", "/api/v1/chat/direct", { people: [mate.id] })).json().id;
    expect(messages(await heard(mate, () => send(rep, dm, "You there?")), dm)[0]!.data).toMatchObject({
      d: true,
    });
    // Ids and a kind only: never the words.
    expect(JSON.stringify(mine)).not.toContain("Booked");
    expect(messages(await theirs, ch)).toEqual([]);
  });

  it("taken out of a channel, the next message never reaches them", async () => {
    const after = await heard(mate, async () => {
      // Heard once while in, so who's in is known before it changes.
      await send(rep, ch, "For everyone");
      await new Promise((r) => setTimeout(r, 300));
      await as(admin, "PUT", `/api/v1/chat/channels/${ch}/members`, {
        people: [admin.id, rep.id],
        groups: [],
      });
      await send(rep, ch, "Only for us now");
    });
    // They hear that they're out (their list drops it), and nothing said after.
    expect(after).toContainEqual({ event: "chat", data: { e: "members" } });
    const out = after.findIndex((x) => x.data.e === "members");
    expect(JSON.stringify(after.slice(out))).not.toContain(ch);
    expect(messages(after, ch)).toHaveLength(1);
  });

  it("leaving a team takes a person out of its channel on every open stream", async () => {
    const team = await h.seedTeam(admin.id, [mate.id]);
    const c2 = (
      await as(admin, "POST", "/api/v1/chat/channels", {
        name: "floor",
        groups: [{ kind: "team", id: team }],
      })
    ).json().id;
    const after = await heard(mate, async () => {
      await send(admin, c2, "For the floor");
      await new Promise((r) => setTimeout(r, 300));
      await h.ownerPool.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [
        team,
        mate.id,
      ]);
      await new Promise((r) => setTimeout(r, 300));
      await send(admin, c2, "For the floor now");
    });
    expect(messages(after, c2)).toHaveLength(1);
    expect(after).toContainEqual({ event: "chat", data: { e: "members" } });
    // A team change that moves nobody in any channel says nothing.
    const other = await h.seedTeam(admin.id, []);
    const quiet = await heard(mate, () =>
      h.ownerPool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [other, mate.id]),
    );
    expect(quiet).toEqual([]);
  });

  it("the more people hear an event, the further apart each screen reads", () => {
    expect(spacingMs(1)).toBe(0);
    expect(spacingMs(20)).toBe(0);
    expect(spacingMs(200)).toBe(2000);
    expect(spacingMs(10_000)).toBe(4000);
  });

  it("a lead thread's message reaches only people who can see the lead, and stops when the lead moves away", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Priya Shah" });
    const t = (await as(admin, "POST", `/api/v1/chat/leads/${lead}`)).json().id;
    const said = messages(await heard(rep, () => send(admin, t, "Call her at 4")), t);
    expect(said).toHaveLength(1);
    // Marked as a lead's thread, and never whose lead it is.
    expect(said[0]!.data).toEqual({ c: t, e: "message", m: expect.any(Number), u: admin.id, l: true });
    expect(messages(await heard(mate, () => send(admin, t, "Still at 4")), t)).toEqual([]);
    await h.queryAll("UPDATE leads SET owner_id = $1 WHERE id = $2 RETURNING id", [mate.id, lead]);
    expect(messages(await heard(rep, () => send(admin, t, "Moved to 5")), t)).toEqual([]);
    expect(messages(await heard(mate, () => send(admin, t, "Moved to 5 again")), t)).toHaveLength(1);
  });

  it("typing is said to the others at most every 3 s, never to the one typing", async () => {
    const typing = (hs: Heard[]) => hs.filter((x) => x.data.e === "typing");
    const theirs = heard(mate, async () => undefined, 1500);
    const own = await heard(rep, async () => {
      await as(rep, "POST", `/api/v1/chat/${ch}/typing`);
      await as(rep, "POST", `/api/v1/chat/${ch}/typing`);
    });
    expect(typing(own)).toEqual([]);
    expect(typing(await theirs)).toEqual([{ event: "chat", data: { c: ch, e: "typing", u: rep.id } }]);
  });

  it("who's online: someone with a stream open, among people one shares a conversation with", async () => {
    const online = async (u: SeededUser) =>
      (await (await h.signIn(u)).inject({ method: "GET", url: "/api/v1/chat/online" })).json().online;
    // Two streams open: one of someone they share a channel with, one of someone they share nothing with.
    const theirs = heard(outsider, async () => undefined, 1500);
    await heard(mate, async () => {
      expect(await online(rep)).toEqual([mate.id]);
      expect(await online(mate)).toEqual([]);
      expect(await online(outsider)).toEqual([]);
      // In the channel and here, but they don't chat: their dot would never go out.
      const silent = await h.seedUser({ name: "Old Hand", grants: [{ key: "leads.view", scope: "own" }] });
      await h.ownerPool.query("INSERT INTO chat_members (conversation_id, user_id) VALUES ($1, $2)", [
        ch,
        silent.id,
      ]);
      await heard(silent, async () => expect(await online(rep)).toEqual([mate.id]), 300);
    });
    await theirs;
    // Both following one lead isn't sharing a conversation.
    const lead = await h.seedLead({ ownerId: outsider.id, name: "Kabir Das" });
    const t = (await as(outsider, "POST", `/api/v1/chat/leads/${lead}`)).json().id;
    await send(outsider, t, "Mine");
    await send(admin, t, "Seen");
    await heard(outsider, async () => {
      expect(await online(admin)).toEqual([]);
    });
  });
});

describe("chat events on the channel", () => {
  it("a payload with anything wrong in it is dropped", () => {
    const c = "0190e0c0-0000-7000-8000-0000000003a1";
    expect(chatEventOf(JSON.stringify({ c, e: "message", m: 5 }))).toEqual({ c, e: "message", m: 5 });
    expect(chatEventOf(JSON.stringify({ c, e: "shout" }))).toBeNull();
    expect(chatEventOf(JSON.stringify({ c: "not-an-id", e: "message" }))).toBeNull();
    expect(chatEventOf(JSON.stringify({ e: "message" }))).toBeNull();
    expect(chatEventOf(JSON.stringify({ c, e: "message", m: -1 }))).toBeNull();
    expect(chatEventOf(JSON.stringify({ c, e: "message", lead: true, o: "x" }))).toBeNull();
    expect(chatEventOf(JSON.stringify({ e: "members" }))).toEqual({ e: "members" });
    expect(chatEventOf("{oops")).toBeNull();
  });
});
