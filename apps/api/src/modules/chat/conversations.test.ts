import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { noticesForgotten } from "./notices";

/** Team Chat's conversations (plan 2026-11-24-team-chat-2a, Task 3): lists, channels, direct messages, lead threads. */
let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
let mate: SeededUser;

const as = async (
  u: SeededUser,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) => (await h.signIn(u)).inject({ method, url, ...(payload ? { payload } : {}) });
const list = async (u: SeededUser) => (await as(u, "GET", "/api/v1/chat")).json();
const say = (u: SeededUser, conv: string, body: string) =>
  as(u, "POST", `/api/v1/chat/${conv}/messages`, { clientId: crypto.randomUUID(), body });

beforeAll(async () => {
  h = await createHarness();
  admin = await h.seedUser({
    name: "Maya Kapoor",
    grants: [
      { key: "chat.use", scope: null },
      { key: "chat.channels.manage", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  rep = await h.seedUser({
    name: "Rahul Mehta",
    grants: [
      { key: "chat.use", scope: null },
      { key: "leads.view", scope: "own" },
    ],
  });
  mate = await h.seedUser({
    name: "Sana Iqbal",
    grants: [
      { key: "chat.use", scope: null },
      { key: "leads.view", scope: "own" },
    ],
  });
});
afterAll(async () => h.close());
/** Every test from #general and #wins alone (row security is forced even for the owner: TRUNCATE, then as a person). */
beforeEach(async () => {
  await noticesForgotten();
  await h.ownerPool.query("TRUNCATE chat_conversations, chat_list_folds CASCADE");
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [admin.id]);
    const [g, w] = [crypto.randomUUID(), crypto.randomUUID()];
    await c.query(
      "INSERT INTO chat_conversations (id, kind, name) VALUES ($1, 'channel', 'general'), ($2, 'channel', 'wins')",
      [g, w],
    );
    // The triggers put everyone in.
    await c.query(
      "INSERT INTO chat_channel_groups (channel_id, kind) VALUES ($1, 'everyone'), ($2, 'everyone')",
      [g, w],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
});

describe("GET /api/v1/chat", () => {
  it("lists only the channels the person is in, their direct messages, and lead threads they follow", async () => {
    const made = await as(admin, "POST", "/api/v1/chat/channels", { name: "closers", people: [rep.id] });
    expect(made.statusCode, made.body).toBe(201);
    expect((await list(rep)).channels.map((c: { name: string }) => c.name)).toEqual([
      "closers",
      "general",
      "wins",
    ]);
    expect((await list(mate)).channels.map((c: { name: string }) => c.name)).toEqual(["general", "wins"]);
    const dm = (await as(rep, "POST", "/api/v1/chat/direct", { people: [mate.id] })).json();
    expect((await list(mate)).direct.map((c: { id: string }) => c.id)).toEqual([dm.id]);
    expect((await list(admin)).direct).toEqual([]);
  });

  it("unread counts skip one's own messages and deleted ones; a muted channel isn't in the total", async () => {
    const ch = (
      await as(admin, "POST", "/api/v1/chat/channels", { name: "ops", people: [rep.id, mate.id] })
    ).json();
    // Writing in a conversation reads it, so Sana writes first.
    await say(mate, ch.id, "Mine");
    await say(rep, ch.id, "One");
    await say(rep, ch.id, "Two");
    const gone = (await say(rep, ch.id, "Three")).json();
    await as(rep, "DELETE", `/api/v1/chat/messages/${gone.id}`);
    const m = await list(mate);
    expect(m.channels.find((c: { name: string }) => c.name === "ops").unread).toBe(2);
    expect(m.unread).toBe(2);
    await as(mate, "PUT", `/api/v1/chat/${ch.id}/mute`, { muted: true });
    const muted = await list(mate);
    expect(muted.channels.find((c: { name: string }) => c.name === "ops")).toMatchObject({
      unread: 2,
      muted: true,
    });
    expect(muted.unread).toBe(0);
  });

  it("a fold is kept per person and list", async () => {
    expect((await list(rep)).folds).toEqual({ channels: false, direct: false, leads: false });
    expect((await as(rep, "PUT", "/api/v1/chat/folds", { list: "leads", folded: true })).statusCode).toBe(
      204,
    );
    expect((await list(rep)).folds).toEqual({ channels: false, direct: false, leads: true });
    expect((await list(mate)).folds.leads).toBe(false);
  });
});

describe("channels", () => {
  it("a person without chat.channels.manage can't make, rename or fill a channel", async () => {
    expect((await as(rep, "POST", "/api/v1/chat/channels", { name: "mine" })).statusCode).toBe(403);
    const ch = (await as(admin, "POST", "/api/v1/chat/channels", { name: "team", people: [rep.id] })).json();
    expect((await as(rep, "PATCH", `/api/v1/chat/channels/${ch.id}`, { name: "renamed" })).statusCode).toBe(
      403,
    );
    expect(
      (
        await as(rep, "PUT", `/api/v1/chat/channels/${ch.id}/members`, {
          people: [rep.id, mate.id],
          groups: [],
        })
      ).statusCode,
    ).toBe(403);
  });

  it("a name is checked, and taken once among open channels", async () => {
    const bad = await as(admin, "POST", "/api/v1/chat/channels", { name: "Sales Team" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe("Use lower case letters, digits and dashes, like spring-batch.");
    expect((await as(admin, "POST", "/api/v1/chat/channels", { name: "deals" })).statusCode).toBe(201);
    const taken = await as(admin, "POST", "/api/v1/chat/channels", { name: "deals" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.message).toBe("There's already a channel called #deals.");
  });

  it("taking someone out stops their list showing it; a team keeps its people in", async () => {
    const ch = (
      await as(admin, "POST", "/api/v1/chat/channels", { name: "floor", people: [rep.id, mate.id] })
    ).json();
    await as(admin, "PUT", `/api/v1/chat/channels/${ch.id}/members`, {
      people: [admin.id, rep.id],
      groups: [],
    });
    expect((await list(mate)).channels.map((c: { name: string }) => c.name)).not.toContain("floor");
    const team = await h.seedTeam(admin.id, [mate.id]);
    await as(admin, "PUT", `/api/v1/chat/channels/${ch.id}/members`, {
      people: [admin.id, rep.id],
      groups: [{ kind: "team", id: team }],
    });
    expect((await list(mate)).channels.map((c: { name: string }) => c.name)).toContain("floor");
    const audits = await h.queryAll<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id",
      [ch.id],
    );
    expect(audits.map((a) => a.action)).toEqual([
      "chat.channel.created",
      "chat.members.changed",
      "chat.members.changed",
    ]);
  });
});

describe("direct messages", () => {
  it("the same people are the same conversation, whoever starts it, even at once", async () => {
    const [a, b] = await Promise.all([
      as(rep, "POST", "/api/v1/chat/direct", { people: [mate.id] }),
      as(mate, "POST", "/api/v1/chat/direct", { people: [rep.id] }),
    ]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    expect(a.json().id).toBe(b.json().id);
  });

  it("at most 8 people, never oneself alone, never someone disabled", async () => {
    expect((await as(rep, "POST", "/api/v1/chat/direct", { people: [] })).statusCode).toBe(400);
    expect((await as(rep, "POST", "/api/v1/chat/direct", { people: [rep.id] })).statusCode).toBe(400);
    const off = await h.seedUser({
      name: "Gone Person",
      status: "disabled",
      grants: [{ key: "chat.use", scope: null }],
    });
    expect((await as(rep, "POST", "/api/v1/chat/direct", { people: [off.id] })).statusCode).toBe(400);
    const many = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        h.seedUser({ name: `P ${i}`, grants: [{ key: "chat.use", scope: null }] }),
      ),
    );
    const nine = await as(rep, "POST", "/api/v1/chat/direct", { people: many.map((u) => u.id) });
    expect(nine.statusCode).toBe(400);
    expect(nine.json().error.message).toBe("A direct message can have at most 8 people.");
  });
});

describe("lead threads", () => {
  it("a lead the person can't see is 404; its owner and whoever sees it get its thread", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Priya Shah" });
    expect((await as(mate, "POST", `/api/v1/chat/leads/${lead}`)).statusCode).toBe(404);
    const t = await as(rep, "POST", `/api/v1/chat/leads/${lead}`);
    expect(t.statusCode, t.body).toBe(200);
    const again = await as(admin, "POST", `/api/v1/chat/leads/${lead}`);
    expect(again.json().id).toBe(t.json().id);
  });

  it("listed for the lead's owner once it has a message, and stops listing when the lead moves away", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Priya Shah" });
    const t = (await as(admin, "POST", `/api/v1/chat/leads/${lead}`)).json();
    expect((await list(rep)).leads).toEqual([]);
    await say(admin, t.id, "Booked Thursday");
    expect((await list(rep)).leads).toMatchObject([
      { id: t.id, unread: 1, lead: { id: lead, name: "Priya Shah" } },
    ]);
    await h.queryAll("UPDATE leads SET owner_id = $1 WHERE id = $2 RETURNING id", [mate.id, lead]);
    expect((await list(rep)).leads).toEqual([]);
    expect((await list(mate)).leads.map((l: { id: string }) => l.id)).toEqual([t.id]);
  });
});
