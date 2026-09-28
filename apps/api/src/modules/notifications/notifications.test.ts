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
    const again = await stream(me, { lastEventId: seen, until: 2 });
    expect(again.events.map((e) => e.title)).toEqual(["While away"]);
  });
});
