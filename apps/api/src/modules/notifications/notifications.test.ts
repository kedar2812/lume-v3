import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let base: string;
let me: AuthedClient;
let meId: string;
let someone: AuthedClient;
let someoneId: string;

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  const a = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true });
  const b = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true });
  meId = a.id;
  someoneId = b.id;
  me = await h.signIn(a);
  someone = await h.signIn(b);
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(() => h.close());

/** A notification for this person, as the fire job writes it (as them), announced on the channel. */
async function notify(userId: string, title: string): Promise<number> {
  const c: pg.PoolClient = await h.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [userId]);
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, 'follow_up_due', $2, 'Now') RETURNING id",
      [userId, title],
    );
    await c.query("SELECT pg_notify('lume_notifications', $1)", [
      JSON.stringify({ u: userId, n: Number(rows[0]!.id) }),
    ]);
    await c.query("COMMIT");
    return Number(rows[0]!.id);
  } finally {
    c.release();
  }
}
const cookie = (c: AuthedClient) =>
  Object.entries(c.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

/** Open the stream and collect its events until `n` have arrived (or the time runs out). */
async function stream(
  c: AuthedClient,
  o: { lastEventId?: number; until: number; after?: () => Promise<unknown> },
) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/v1/stream`, {
    headers: { cookie: cookie(c), ...(o.lastEventId ? { "last-event-id": String(o.lastEventId) } : {}) },
    signal: ac.signal,
  });
  const events: { id: number; title: string }[] = [];
  const reader = res.body!.getReader();
  const text = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => ac.abort(), 3000);
  void o.after?.();
  try {
    while (events.length < o.until) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += text.decode(value);
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const id = /^id: (\d+)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (id && data) events.push({ id: Number(id), title: JSON.parse(data).title });
      }
    }
  } catch {
    // aborted: whatever arrived is the answer
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return { status: res.status, type: res.headers.get("content-type"), events };
}

describe("notifications (Phase 3 spec §7)", () => {
  it("lists my own, with the unread count; marking read by id or all at once", async () => {
    const a = await notify(meId, "First for me");
    await notify(meId, "Second for me");
    await notify(someoneId, "Not mine");
    const list = (await me.inject({ method: "GET", url: "/api/v1/notifications" })).json();
    expect(list.items.map((n: { title: string }) => n.title)).toEqual(["Second for me", "First for me"]);
    expect(list.unread).toBe(2);
    const one = await me.inject({ method: "POST", url: "/api/v1/notifications/read", payload: { ids: [a] } });
    expect(one.json()).toEqual({ unread: 1 });
    const all = await me.inject({
      method: "POST",
      url: "/api/v1/notifications/read",
      payload: { all: true },
    });
    expect(all.json()).toEqual({ unread: 0 });
    expect((await someone.inject({ method: "GET", url: "/api/v1/notifications" })).json().unread).toBe(1);
  });

  it("Clear read takes away only my read ones, leaves the unread, and Undo brings exactly those back", async () => {
    await me.inject({ method: "POST", url: "/api/v1/notifications/read", payload: { all: true } });
    const fresh = await notify(meId, "Still unread");
    await notify(someoneId, "Someone's read one");
    await someone.inject({ method: "POST", url: "/api/v1/notifications/read", payload: { all: true } });
    const titles = async (c: typeof me) =>
      (await c.inject({ method: "GET", url: "/api/v1/notifications" }))
        .json()
        .items.map((n: { title: string }) => n.title);
    const before = await titles(me);
    expect(before.length).toBeGreaterThan(1);
    const cleared = (await me.inject({ method: "POST", url: "/api/v1/notifications/clear-read" })).json()
      .cleared;
    expect(cleared).toHaveLength(before.length - 1);
    expect(cleared).not.toContain(fresh);
    expect(await titles(me)).toEqual(["Still unread"]);
    expect(await titles(someone)).toContain("Someone's read one");
    const undo = await me.inject({
      method: "POST",
      url: "/api/v1/notifications/clear-read/undo",
      payload: { ids: cleared },
    });
    expect(undo.json()).toEqual({ restored: cleared.length });
    expect(await titles(me)).toEqual(before);
  });
});

describe("the live stream", () => {
  it("answers 401 without a session", async () => {
    expect((await fetch(`${base}/api/v1/stream`)).status).toBe(401);
  });

  it("delivers a new notification to its person only", async () => {
    const theirs = stream(someone, { until: 1 });
    const mine = await stream(me, { until: 1, after: () => notify(meId, "Live one") });
    expect(mine.status).toBe(200);
    expect(mine.type).toMatch(/^text\/event-stream/);
    expect(mine.events.map((e) => e.title)).toEqual(["Live one"]);
    expect((await theirs).events).toEqual([]);
  });

  it("Review Focus 5: after a reconnect, only what was missed arrives, once", async () => {
    const first = await stream(me, { until: 1, after: () => notify(meId, "Before the drop") });
    const seen = first.events[0]!.id;
    await notify(meId, "While away");
    const again = await stream(me, { lastEventId: seen, until: 50 });
    // What was missed arrives once. The replay starts a little before Last-Event-ID (ids can commit out of
    // order, final review Important 3), so earlier ones may come again; the browser drops those by id.
    expect(again.events.filter((e) => e.title === "While away")).toHaveLength(1);
    expect(new Set(again.events.map((e) => e.id)).size).toBe(again.events.length);
  });
});

describe("3A final review", () => {
  it("Important 3: a notification that commits after a later one still arrives", async () => {
    const early = await h.pool.connect();
    await early.query("BEGIN");
    await early.query("SELECT set_config('lume.user_id', $1, true)", [meId]);
    const { rows } = await early.query<{ id: string }>(
      "INSERT INTO notifications (user_id, kind, title) VALUES ($1, 'follow_up_due', 'Slow to commit') RETURNING id",
      [meId],
    );
    const got = await stream(me, {
      until: 2,
      after: async () => {
        await notify(meId, "Quick to commit"); // a later id, committed first
        await early.query("SELECT pg_notify('lume_notifications', $1)", [
          JSON.stringify({ u: meId, n: Number(rows[0]!.id) }),
        ]);
        await early.query("COMMIT");
        early.release();
      },
    });
    expect(got.events.map((e) => e.title).sort()).toEqual(["Quick to commit", "Slow to commit"]);
  });

  it("Important 3: more than 50 missed are all replayed", async () => {
    const first = await stream(me, { until: 1, after: () => notify(meId, "Anchor") });
    for (let i = 0; i < 60; i++) await notify(meId, `Missed ${i}`);
    const again = await stream(me, { lastEventId: first.events[0]!.id, until: 60 });
    expect(new Set(again.events.map((e) => e.title)).size).toBeGreaterThanOrEqual(60);
  });

  it("Important 4: the stream also takes where to resume from as ?after=, for a browser reconnecting by hand", async () => {
    const first = await stream(me, { until: 1, after: () => notify(meId, "Before a restart") });
    await notify(meId, "During the restart");
    const ac = new AbortController();
    const res = await fetch(`${base}/api/v1/stream?after=${first.events[0]!.id}`, {
      headers: { cookie: cookie(me) },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    let text = "";
    const stop = setTimeout(() => ac.abort(), 2000);
    try {
      while (!text.includes("During the restart"))
        text += new TextDecoder().decode((await reader.read()).value);
    } catch {
      // aborted
    }
    clearTimeout(stop);
    ac.abort();
    expect(text).toContain("During the restart");
  });

  it("signing out ends that session's open stream (it doesn't outlive the session)", async () => {
    const u = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true });
    const c = await h.signIn(u);
    const ac = new AbortController();
    const res = await fetch(`${base}/api/v1/stream`, { headers: { cookie: cookie(c) }, signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read(); // connected
    await c.inject({ method: "POST", url: "/api/v1/auth/logout" });
    const ended = await Promise.race([
      (async () => {
        for (;;) if ((await reader.read()).done) return true;
      })(),
      new Promise<false>((r) => setTimeout(() => r(false), 3000)),
    ]);
    ac.abort();
    expect(ended).toBe(true);
  });

  it("a browser that stops reading is let go rather than piled up in memory", async () => {
    const { streamWriter } = await import("./hub");
    const chunks: string[] = [];
    let destroyed = false;
    const res = {
      writableLength: 0,
      write: (c: string) => (chunks.push(c), true),
      end: () => undefined,
      destroy: () => void (destroyed = true),
    };
    const w = streamWriter(res, 1024);
    expect(w.write("a")).toBe(true);
    res.writableLength = 2048; // the socket isn't taking what's sent
    expect(w.write("b")).toBe(false);
    // A socket that isn't taking anything is let go at once (end() would wait on it).
    expect(destroyed).toBe(true);
    expect(chunks).toEqual(["a"]);
  });

  it("stopped (a session ended), the stream writes nothing more: no write after its end", async () => {
    const { streamWriter } = await import("./hub");
    const chunks: string[] = [];
    let ended = 0;
    const res = {
      writableLength: 0,
      write: (c: string) => (chunks.push(c), true),
      end: () => void ended++,
      destroy: () => undefined,
    };
    const w = streamWriter(res);
    w.stop();
    expect(w.write(": ping\n\n")).toBe(false);
    w.stop();
    expect(ended).toBe(1);
    expect(chunks).toEqual([]);
  });

  it("Important 6: an open stream never holds up the API shutting down", async () => {
    const other = await createHarness({ preset: "general" });
    const u = await other.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true });
    const c = await other.signIn(u);
    await other.app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(other.app.server.address() as AddressInfo).port}/api/v1/stream`;
    const ac = new AbortController();
    await fetch(url, { headers: { cookie: cookie(c) }, signal: ac.signal });
    const started = Date.now();
    await other.close();
    ac.abort();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

/** Open the stream for `ms` and collect every event block, raw: its event name, and whether it had an id. */
async function blocks(c: AuthedClient, o: { ms: number; after?: () => Promise<unknown> }) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/v1/stream`, { headers: { cookie: cookie(c) }, signal: ac.signal });
  const out: { event: string; id: string | null }[] = [];
  const reader = res.body!.getReader();
  const text = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => ac.abort(), o.ms);
  setTimeout(() => void o.after?.(), 100);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += text.decode(value);
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (\w+)$/m.exec(block)?.[1];
        if (event) out.push({ event, id: /^id: (\d+)$/m.exec(block)?.[1] ?? null });
      }
    }
  } catch {
    // the time ran out: whatever arrived is the answer
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return out;
}

describe("leads changed on the live stream (4B Task 4)", () => {
  it("a lead change reaches an open stream as one `leads` event, with no id and nothing about the lead", async () => {
    const got = await blocks(me, {
      ms: 1500,
      after: () => h.seedLead({ ownerId: someoneId, name: "Not yours" }),
    });
    const leads = got.filter((b) => b.event === "leads");
    expect(leads).toEqual([{ event: "leads", id: null }]);
  });

  it("Review Focus 4: ten changes within a second arrive as at most two", async () => {
    const got = await blocks(me, {
      ms: 4500,
      after: async () => {
        for (let i = 0; i < 10; i++) await h.seedLead({ ownerId: meId, name: `Burst ${i}` });
      },
    });
    const n = got.filter((b) => b.event === "leads").length;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(2);
  }, 10_000);

  it("a notification after a `leads` event still carries its id", async () => {
    const got = await blocks(me, {
      ms: 2000,
      after: async () => {
        await h.seedLead({ ownerId: meId, name: "Then a note" });
        await notify(meId, "After leads");
      },
    });
    expect(got.find((b) => b.event === "notification")?.id).toMatch(/^\d+$/);
  });

  it("someone who can't see leads isn't told when leads change", async () => {
    const u = await h.seedUser({ grants: [], totp: true });
    const c = await h.signIn(u);
    const got = await blocks(c, {
      ms: 1500,
      after: () => h.seedLead({ ownerId: someoneId, name: "Not for them" }),
    });
    expect(got.filter((b) => b.event === "leads")).toEqual([]);
  });
});
