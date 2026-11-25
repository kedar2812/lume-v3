import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../harness";

/**
 * Team Chat at scale (plan 2026-11-24-team-chat-2a): a thousand people, a channel with everyone and a million messages,
 * and tens of thousands of lead threads. Skipped unless LUME_SCALE is set (how many messages): `LUME_SCALE=1000000
 * vitest run apps/api/test/scale/chat`.
 */
const N = Number(process.env.LUME_SCALE ?? 0);
if (N && process.env.SCALE_DATABASE_URL)
  for (const [k, v] of Object.entries(process.env))
    if (k.startsWith("SCALE_") && v) process.env[`TEST_${k.slice(6)}`] = v;
const PEOPLE = 1000;
const CHANNELS = 200;
const STREAMS = 200;
const THREADS = Math.min(50_000, Math.ceil(N / 20));
/** Everything a person waits for, on one connection, with the database busy seeding nothing else. */
const TARGET_MS = 250;

let h: Harness;
let rep: AuthedClient;
let boss: AuthedClient;
let everyone: string;
let repId: string;
let bossId: string;

async function time(
  what: string,
  call: () => Promise<{ statusCode: number; body: string }>,
  target = TARGET_MS,
) {
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const r = await call();
    ms.push(performance.now() - t);
    expect(r.statusCode, `${what}: ${r.body.slice(0, 300)}`).toBeLessThan(300);
  }
  ms.sort((a, b) => a - b);
  const mid = Math.round(ms[2]!);
  console.log(`chat ${what.padEnd(44)} ${String(mid).padStart(6)} ms`);
  expect.soft(mid, what).toBeLessThan(target);
}

describe.skipIf(!N)(`Team Chat at scale: ${N.toLocaleString("en-US")} messages`, () => {
  beforeAll(async () => {
    h = await createHarness({ poolMax: 20 });
    const chats = { key: "chat.use", scope: null } as const;
    const manager = await h.seedUser({
      name: "Hana Ito",
      grants: [chats, { key: "chat.channels.manage", scope: null }, { key: "leads.view", scope: "all" }],
    });
    const one: SeededUser = await h.seedUser({
      name: "Noor Aziz",
      grants: [chats, { key: "leads.view", scope: "own" }],
    });
    boss = await h.signIn(manager);
    [repId, bossId] = [one.id, manager.id];
    rep = await h.signIn(one);
    await h.ownerPool.query("SET statement_timeout = 0");
    await h.ownerPool.query(
      `INSERT INTO users (id, email, name, status)
       SELECT gen_random_uuid(), 'p' || g || '@example.com', 'Person ' || g, 'active' FROM generate_series(1, $1::int) g`,
      [PEOPLE],
    );
    everyone = (
      await boss.inject({
        method: "POST",
        url: "/api/v1/chat/channels",
        payload: { name: "everyone-here", groups: [{ kind: "everyone" }] },
      })
    ).json().id;
    await h.seedLead({ ownerId: one.id, name: "First" });
    // Seeded as it would be found, not as one person could write it: the rule that binds the owner too waits.
    await h.ownerPool.query("ALTER TABLE chat_messages NO FORCE ROW LEVEL SECURITY");
    await h.ownerPool.query(
      `INSERT INTO chat_conversations (id, kind, name) SELECT gen_random_uuid(), 'channel', 'room-' || g FROM generate_series(1, $1::int) g`,
      [CHANNELS],
    );
    await h.ownerPool.query(
      `INSERT INTO chat_members (conversation_id, user_id)
       SELECT c.id, $1 FROM chat_conversations c WHERE c.name LIKE 'room-%' ON CONFLICT DO NOTHING`,
      [one.id],
    );
    await h.queryAll(
      `INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, lead_created_at, created_at, updated_at, last_activity_at, stage_entered_at)
       SELECT gen_random_uuid(), l.pipeline_id, l.stage_id, CASE WHEN g % 10 = 0 THEN $2::uuid ELSE $3::uuid END, 'Lead ' || g,
              now()::date, now(), now(), now(), now()
         FROM (SELECT pipeline_id, stage_id FROM leads LIMIT 1) l, generate_series(1, $1::int) g`,
      [THREADS, one.id, manager.id],
    );
    await h.queryAll(
      `INSERT INTO chat_conversations (id, kind, lead_id) SELECT gen_random_uuid(), 'lead', id FROM leads WHERE name LIKE 'Lead %'`,
    );
    // Each lead's owner has a place in its thread, as saying something there makes it.
    await h.queryAll(
      `INSERT INTO chat_members (conversation_id, user_id, via)
       SELECT c.id, l.owner_id, 'lead' FROM chat_conversations c JOIN leads l ON l.id = c.lead_id ON CONFLICT DO NOTHING`,
    );
    const BATCH = 50_000;
    for (let from = 1; from <= N; from += BATCH)
      await h.ownerPool.query(
        `INSERT INTO chat_messages (conversation_id, author_id, body, client_id)
         SELECT $1, $2, 'Message ' || g || ' about nothing much at all', gen_random_uuid() FROM generate_series($3::int, $4::int) g`,
        [everyone, manager.id, from, Math.min(N, from + BATCH - 1)],
      );
    await h.ownerPool.query(
      `INSERT INTO chat_messages (conversation_id, author_id, body, client_id)
       SELECT c.id, $1, 'In a thread', gen_random_uuid() FROM chat_conversations c, generate_series(1, 3) WHERE c.kind <> 'direct' AND c.id <> $2`,
      [manager.id, everyone],
    );
    await h.ownerPool.query(
      `UPDATE chat_conversations c SET last_message_id = m.id, last_at = now()
         FROM (SELECT conversation_id, max(id) AS id FROM chat_messages GROUP BY 1) m WHERE m.conversation_id = c.id`,
    );
    // In it since before it all: everything is unread.
    await h.ownerPool.query("UPDATE chat_members SET last_read_id = 0");
    await h.ownerPool.query("ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY");
    await h.ownerPool.query("ANALYZE");
  }, 1_800_000);
  afterAll(async () => h.close());

  it("the list, a page, sending, reading and who's in a channel all answer at once", async () => {
    const get = (c: AuthedClient, url: string) => () => c.inject({ method: "GET", url });
    const list = (await rep.inject({ method: "GET", url: "/api/v1/chat" })).json();
    expect(list.channels.length).toBeGreaterThan(CHANNELS);
    expect(list.leads).toHaveLength(50);
    expect(list.channels.find((c: { id: string }) => c.id === everyone).unread).toBe(100);
    await time("the list", get(rep, "/api/v1/chat"));
    await time("the list, for who sees every lead", get(boss, "/api/v1/chat"));
    const fresh = await h.signIn(
      await h.seedUser({ name: "Just Joined", grants: [{ key: "chat.use", scope: null }] }),
    );
    expect((await fresh.inject({ method: "GET", url: "/api/v1/chat/unread" })).json().unread).toBe(0);
    await time("the list, for who joined a moment ago", get(fresh, "/api/v1/chat"));
    await time("the sidebar's number", get(rep, "/api/v1/chat/unread"));
    await time("the newest page", get(rep, `/api/v1/chat/${everyone}/messages`));
    await time(
      "a page half way up",
      get(rep, `/api/v1/chat/${everyone}/messages?before=${Math.floor(N / 2)}`),
    );
    await time("a send", () =>
      rep.inject({
        method: "POST",
        url: `/api/v1/chat/${everyone}/messages`,
        payload: { clientId: crypto.randomUUID(), body: "Hello" },
      }),
    );
    await time("a read", () =>
      rep.inject({ method: "PUT", url: `/api/v1/chat/${everyone}/read`, payload: { upTo: N } }),
    );
    expect(
      (await rep.inject({ method: "GET", url: "/api/v1/chat/people" })).json().people.length,
    ).toBeGreaterThan(PEOPLE);
    await time("everyone who chats", get(rep, "/api/v1/chat/people"));
    await time("channels to manage", get(boss, "/api/v1/chat/channels"));
    await time(
      "a thousand people out of a channel and back",
      async () => {
        const put = (groups: unknown[]) =>
          boss.inject({
            method: "PUT",
            url: `/api/v1/chat/channels/${everyone}/members`,
            payload: { people: [], groups },
          });
        await put([]);
        return put([{ kind: "everyone" }]);
      },
      2000,
    );
  }, 300_000);

  it("a message reaches two hundred open streams together, and saying it isn't slowed by them", async () => {
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
    const heardAt = new Map<number, number>();
    const stop = new AbortController();
    for (let i = 0; i < STREAMS; i++) {
      const u = await h.seedUser({ name: `Listener ${i}`, grants: [{ key: "chat.use", scope: null }] });
      const c = await h.signIn(u);
      const cookie = Object.entries(c.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      const res = await fetch(`${base}/api/v1/stream`, { headers: { cookie }, signal: stop.signal });
      const reader = res.body!.getReader();
      void (async () => {
        const text = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          if (text.decode(value).includes('"e":"message"') && !heardAt.has(i))
            heardAt.set(i, performance.now());
        }
      })().catch(() => undefined);
    }
    const at = performance.now();
    const sent = await rep.inject({
      method: "POST",
      url: `/api/v1/chat/${everyone}/messages`,
      payload: { clientId: crypto.randomUUID(), body: "All hear this" },
    });
    expect(sent.statusCode).toBe(201);
    while (heardAt.size < STREAMS && performance.now() - at < 5000)
      await new Promise((ok) => setTimeout(ok, 20));
    const last = Math.round(Math.max(...heardAt.values()) - at);
    console.log(`chat heard by ${heardAt.size} streams, the last after ${last} ms`);
    expect(heardAt.size).toBe(STREAMS);
    expect(last).toBeLessThan(1500);
    await time("who's online, with them all here", () =>
      rep.inject({ method: "GET", url: "/api/v1/chat/online" }),
    );
    await time("a send, with them all here", () =>
      rep.inject({
        method: "POST",
        url: `/api/v1/chat/${everyone}/messages`,
        payload: { clientId: crypto.randomUUID(), body: "Hello" },
      }),
    );
    stop.abort();
  }, 300_000);

  it("threads: thousands followed, each a reply or two unread, and the list, the bell and a thread still answer at once", async () => {
    const ROOTS = Math.min(5000, Math.ceil(N / 200));
    await h.ownerPool.query("ALTER TABLE chat_messages NO FORCE ROW LEVEL SECURITY");
    // Each root is the rep's (so they follow it), with three replies by someone else: unread for the rep.
    await h.ownerPool.query(
      `INSERT INTO chat_messages (conversation_id, author_id, body, client_id)
       SELECT $1, $2, 'Thread ' || g, gen_random_uuid() FROM generate_series(1, $3::int) g`,
      [everyone, repId, ROOTS],
    );
    await h.ownerPool.query(
      `INSERT INTO chat_messages (conversation_id, author_id, body, client_id, thread_root)
       SELECT $1, $2, 'Reply', gen_random_uuid(), m.id
         FROM (SELECT id FROM chat_messages WHERE conversation_id = $1 AND author_id = $3 AND body LIKE 'Thread %') m,
              generate_series(1, 3)`,
      [everyone, bossId, repId],
    );
    await h.ownerPool.query("ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY");
    await h.ownerPool.query("ANALYZE");
    const list = (await rep.inject({ method: "GET", url: "/api/v1/chat" })).json();
    expect(list.threads.any).toBe(true);
    expect(list.threads.unread).toBeGreaterThan(0);
    const threads = (await rep.inject({ method: "GET", url: "/api/v1/chat/threads" })).json().threads;
    expect(threads).toHaveLength(50);
    const root = threads[0].root.id as number;
    const get = (url: string) => () => rep.inject({ method: "GET", url });
    await time("the list, following thousands of threads", get("/api/v1/chat"), 150);
    await time("the sidebar's number, with them", get("/api/v1/chat/unread"), 150);
    await time("the threads they follow", get("/api/v1/chat/threads"), 300);
    await time("a thread", get(`/api/v1/chat/messages/${root}/thread`), 150);
    await time("the newest page, threads on it", get(`/api/v1/chat/${everyone}/messages`), 150);
    await time("a reply", () =>
      boss.inject({
        method: "POST",
        url: `/api/v1/chat/messages/${root}/thread`,
        payload: { clientId: crypto.randomUUID(), body: "One more" },
      }),
    );
  }, 600_000);
});
