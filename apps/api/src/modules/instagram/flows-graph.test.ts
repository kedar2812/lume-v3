import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IGSID, igDm } from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliverIg, IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";

/**
 * Flows as a graph through the API (plan 2026-11-23-flow-builder, Task A3): the builder's save, versions and bringing
 * one back, the keyword tester, and a graph flow at work (taps down their lines, the numbers on each step, Replay,
 * "no answer after", going on to another flow, telling the team, a follow-up, words off the script).
 */
const H = 3_600_000;
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };

type Node = Record<string, unknown> & { id: string; type: string };
const G = (start: string, ...nodes: Node[]) => ({ v: 2, start, nodes, pos: {}, notes: [] });
const msg = (id: string, o: Record<string, unknown> = {}): Node => ({
  id,
  type: "message",
  text: `Say ${id}`,
  buttons: [],
  replies: [],
  next: null,
  ...o,
});
const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  (await h.signIn(admin)).inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const ts = () => h.clock.now.toISOString();
const sentKeys = async () =>
  (
    await h.queryAll<{ step_key: string }>(
      "SELECT step_key FROM instagram_outbox WHERE step_key <> 'note' ORDER BY created_at, id",
    )
  ).map((r) => r.step_key);
const runs = () =>
  h.queryAll<{ status: string; reason: string | null; flow: string }>(
    `SELECT r.status, r.reason, f.name AS flow FROM instagram_flow_runs r
       JOIN instagram_flows f ON f.id = r.flow_id ORDER BY r.created_at`,
  );

/** A live flow with this graph and a DM keyword, published straight in the tables. */
async function liveFlow(name: string, graph: unknown, keywords: string[]) {
  const id = randomUUID();
  const vid = randomUUID();
  await h.ownerPool.query(
    "INSERT INTO instagram_flows (id, name, status, draft_steps, created_by) VALUES ($1, $2, 'draft', $3, $4)",
    [id, name, JSON.stringify(graph), admin.id],
  );
  await h.ownerPool.query(
    "INSERT INTO instagram_flow_versions (id, flow_id, version, steps, created_by) VALUES ($1, $2, 1, $3, $4)",
    [vid, id, JSON.stringify(graph), admin.id],
  );
  await h.ownerPool.query("UPDATE instagram_flows SET status = 'live', live_version_id = $2 WHERE id = $1", [
    id,
    vid,
  ]);
  if (keywords.length)
    await h.ownerPool.query(
      `INSERT INTO instagram_triggers (id, flow_id, kind, keywords, mode, media_ids, public_replies, cooldown_hours)
       VALUES ($1, $2, 'dm', $3, 'word', '{}', '{}', 0)`,
      [randomUUID(), id, keywords],
    );
  return { id, vid };
}
const dm = async (mid: string, text: string, payload?: string) => {
  await deliverIg(h, igDm({ mid, text, ...(payload ? { quick_reply: { payload } } : {}), at: ts() }));
  await h.runInstagram();
};

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
  });
  h.setRelayUrl("https://relay.test");
  h.clock.now = new Date("2026-11-23T06:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  h.clock.advance(H);
  await h.ownerPool.query(
    "TRUNCATE leads, activities, tasks, instagram_threads, instagram_events, instagram_comments, instagram_outbox, instagram_flows, notifications CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  h.instagramQueued.length = 0;
  h.instagramSendQueued.length = 0;
  ig.tokens.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  ig.profiles.set(IGSID, { name: "Priya Shah", username: "priya.fit" });
  await seedIgAccount(h, { runAs: admin.id });
});

describe("the builder's save", () => {
  it("a 1B list opens as a graph with the same ids; a graph replaces the draft; stale or both forms are refused", async () => {
    let f = (await call("POST", "/api/v1/instagram/flows", { name: "Quiz" })).json();
    f = (
      await call("PUT", `/api/v1/instagram/flows/${f.id}`, {
        rev: f.rev,
        steps: [
          { id: "s1", type: "send", text: "Hi" },
          { id: "s2", type: "send", text: "Bye" },
        ],
      })
    ).json();
    expect(f.graph).toMatchObject({
      v: 2,
      start: "s1",
      nodes: [
        { id: "s1", next: "s2" },
        { id: "s2", next: null },
      ],
    });
    const r = await call("PUT", `/api/v1/instagram/flows/${f.id}`, { rev: f.rev, graph: G("hi", msg("hi")) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ draft: { v: 2, start: "hi" }, problems: [], issues: [] });
    expect(
      (await call("PUT", `/api/v1/instagram/flows/${f.id}`, { rev: f.rev, graph: G("x", msg("x")) }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call("PUT", `/api/v1/instagram/flows/${f.id}`, {
          rev: r.json().rev,
          steps: [],
          graph: G("x", msg("x")),
        })
      ).statusCode,
    ).toBe(400);
    // A graph with a line to nowhere: saved (a draft may be unfinished), its problem on the step.
    const bad = await call("PUT", `/api/v1/instagram/flows/${f.id}`, {
      rev: r.json().rev,
      graph: G("hi", msg("hi", { next: "gone" })),
    });
    expect(bad.json().issues).toContainEqual({
      nodeId: "hi",
      words: "A line leads to a step that isn't there.",
    });
    expect(bad.json().problems).toEqual(["A line leads to a step that isn't there."]);
  });

  it("ways in come back in the order they were saved, every time (one request, one now(): review 2026-11-24)", async () => {
    const f = (await call("POST", "/api/v1/instagram/flows", { name: "Order" })).json();
    const way = (k: string) => ({
      kind: "dm",
      accountId: null,
      keywords: [k],
      mode: "word",
      mediaIds: [],
      adIds: [],
      publicReplies: [],
      cooldownHours: 0,
      enabled: true,
    });
    const ks = ["zebra", "apple", "mango", "kiwi", "banana", "cherry", "date", "fig"];
    let rev = f.rev;
    for (const order of [ks, [...ks].reverse()]) {
      const r = await call("PUT", `/api/v1/instagram/flows/${f.id}/triggers`, {
        rev,
        triggers: order.map(way),
      });
      expect(r.statusCode, r.body).toBe(200);
      rev = r.json().rev;
      expect(r.json().triggers.map((t: { keywords: string[] }) => t.keywords[0])).toEqual(order);
      const back = (await call("GET", `/api/v1/instagram/flows/${f.id}`)).json();
      expect(back.triggers.map((t: { keywords: string[] }) => t.keywords[0])).toEqual(order);
    }
    // Rows rewritten on disk (any update moves a row to the end of the table): the order still reads as saved, because
    // it comes from created_at, never from where the rows happen to sit.
    await h.queryAll(
      "UPDATE instagram_triggers SET enabled = enabled WHERE flow_id = $1 AND keywords[1] = ANY($2::text[])",
      [f.id, ["fig", "date", "cherry"]],
    );
    const moved = (await call("GET", `/api/v1/instagram/flows/${f.id}`)).json();
    expect(moved.triggers.map((t: { keywords: string[] }) => t.keywords[0])).toEqual([...ks].reverse());
    // A copy keeps them in the same order.
    const c = (await call("POST", `/api/v1/instagram/flows/${f.id}/duplicate`)).json();
    expect(c.triggers.map((t: { keywords: string[] }) => t.keywords[0])).toEqual([...ks].reverse());
  });

  it("publish a graph; versions say what changed; one brought back is the draft, and what's live stays", async () => {
    let f = (await call("POST", "/api/v1/instagram/flows", { name: "Quiz" })).json();
    f = (
      await call("PUT", `/api/v1/instagram/flows/${f.id}`, { rev: f.rev, graph: G("hi", msg("hi")) })
    ).json();
    f = (
      await call("PUT", `/api/v1/instagram/flows/${f.id}/triggers`, {
        rev: f.rev,
        triggers: [
          {
            kind: "dm",
            accountId: null,
            keywords: ["quiz"],
            mode: "word",
            mediaIds: [],
            adIds: [],
            publicReplies: [],
            cooldownHours: 0,
            enabled: true,
          },
        ],
      })
    ).json();
    f = (await call("POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: f.rev })).json();
    f = (
      await call("PUT", `/api/v1/instagram/flows/${f.id}`, {
        rev: f.rev,
        graph: G("hi", msg("hi", { text: "Changed", next: "more" }), msg("more")),
      })
    ).json();
    f = (await call("POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: f.rev })).json();
    const v = (await call("GET", `/api/v1/instagram/flows/${f.id}/versions`)).json().versions;
    expect(v.map((x: { version: number; live: boolean }) => [x.version, x.live])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(v[0].changes).toEqual({ added: 1, removed: 0, changed: 1 });
    expect(v[0].createdBy).toMatchObject({ id: admin.id });
    const back = await call("POST", `/api/v1/instagram/flows/${f.id}/versions/${v[1].id}/restore`, {
      rev: f.rev,
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().draft).toEqual(G("hi", msg("hi")));
    expect(back.json().live.version).toBe(2);
    const audit = await h.queryAll(
      "SELECT 1 FROM audit_log WHERE action = 'instagram.flow.restored' AND entity_id = $1",
      [f.id],
    );
    expect(audit).toHaveLength(1);
    // Stale: refused, never a silent overwrite.
    expect(
      (await call("POST", `/api/v1/instagram/flows/${f.id}/versions/${v[0].id}/restore`, { rev: f.rev }))
        .statusCode,
    ).toBe(409);
  });

  it("the keyword tester: these words start this flow, and which other flows they'd start too", async () => {
    await liveFlow("Pricing", G("p", msg("p")), ["price"]);
    const r = await call("POST", "/api/v1/instagram/flows/test-keyword", {
      text: "What's the PRICE?",
      keywords: ["price", "cost"],
      mode: "word",
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      starts: true,
      keyword: "price",
      overlaps: [{ name: "Pricing", keyword: "price" }],
    });
    const no = await call("POST", "/api/v1/instagram/flows/test-keyword", {
      text: "hello",
      keywords: ["price"],
      mode: "word",
    });
    expect(no.json()).toMatchObject({ starts: false, keyword: null, overlaps: [] });
  });
});

describe("a graph flow at work", () => {
  it("a tap goes down its line; each step entered is counted, with its lines; Replay shows the way", async () => {
    const f = await liveFlow(
      "Quiz",
      G(
        "hi",
        msg("hi", {
          replies: [
            { id: "y", title: "Yes", next: "yes" },
            { id: "n", title: "No", next: "no" },
          ],
        }),
        msg("yes"),
        msg("no"),
      ),
      ["quiz"],
    );
    await dm("m1", "quiz please");
    expect(await sentKeys()).toEqual(["hi"]);
    await dm("m2", "Yes", "qr:hi:y");
    expect(await sentKeys()).toEqual(["hi", "yes"]);
    const day = h.clock.now.toISOString().slice(0, 10);
    const stats = (await call("GET", `/api/v1/instagram/flows/${f.id}/stats?from=${day}&to=${day}`)).json();
    expect(stats.byStep).toMatchObject({
      hi: { entered: 1, people: 1, sent: 1 },
      yes: { entered: 1, sent: 1 },
    });
    expect(stats.byStep.no).toBeUndefined();
    expect(stats.byLine).toEqual({ "hi>yes": 1 });
    const lead = (await h.queryAll<{ id: string }>("SELECT id FROM leads"))[0]!.id;
    const replay = (await call("GET", `/api/v1/instagram/flows/${f.id}/runs?lead=${lead}`)).json();
    expect(replay.runs).toHaveLength(1);
    expect(replay.runs[0]).toMatchObject({ status: "done", version: 1, waiting: null });
    expect(replay.runs[0].trail.map((t: { step: string }) => t.step)).toEqual(["hi", "yes"]);
  });

  it("words off the script, with no 'anything else' line: a person reads them", async () => {
    await liveFlow(
      "Quiz",
      G("hi", msg("hi", { replies: [{ id: "y", title: "Yes", next: "yes" }] }), msg("yes")),
      ["quiz"],
    );
    await dm("m1", "quiz");
    await dm("m2", "maybe later?");
    expect(await runs()).toEqual([expect.objectContaining({ status: "handed" })]);
  });

  it("no answer after an hour: the flow's own nudge goes, while Meta allows a reply", async () => {
    await liveFlow(
      "Ask",
      G(
        "q",
        {
          id: "q",
          type: "ask",
          text: "Your email?",
          save: { field: "email", kind: "email" },
          retry: "That doesn't look like an email.",
          next: null,
          noAnswer: { afterMinutes: 60, next: "nudge" },
        },
        msg("nudge"),
      ),
      ["quiz"],
    );
    await dm("m1", "quiz");
    expect(await sentKeys()).toEqual(["q"]);
    h.clock.advance(30 * 60_000);
    await h.runInstagramFlows();
    expect(await sentKeys()).toEqual(["q"]);
    h.clock.advance(31 * 60_000);
    await h.runInstagramFlows();
    expect(await sentKeys()).toEqual(["q", "nudge"]);
  });

  it("go on to another flow: it starts on the same conversation; one that isn't live is noted on the lead", async () => {
    const next = await liveFlow("Next", G("b1", msg("b1")), []);
    await liveFlow("First", G("a", msg("a", { next: "g" }), { id: "g", type: "goto", flowId: next.id }), [
      "start",
    ]);
    await dm("m1", "start");
    expect(await sentKeys()).toEqual(["a", "b1"]);
    expect((await runs()).map((r) => [r.flow, r.status])).toEqual([
      ["First", "done"],
      ["Next", "done"],
    ]);
    await h.ownerPool.query("UPDATE instagram_flows SET status = 'paused' WHERE id = $1", [next.id]);
    h.clock.advance(H);
    await dm("m2", "start again");
    const noted = await h.queryAll<{ payload: { problem: string } }>(
      "SELECT payload FROM activities WHERE type = 'instagram_flow_problem'",
    );
    expect(noted.map((n) => n.payload.problem)).toEqual(["The flow this one goes on to isn't live."]);
  });

  it("two flows that send people back and forth stop after three hops, saying so", async () => {
    const a = randomUUID();
    const b = await liveFlow("B", G("b", msg("b", { next: "g" }), { id: "g", type: "goto", flowId: a }), []);
    // A, published with the id B points at.
    const vid = randomUUID();
    const graph = G("a", msg("a", { next: "g" }), { id: "g", type: "goto", flowId: b.id });
    await h.ownerPool.query(
      "INSERT INTO instagram_flows (id, name, status, draft_steps, created_by) VALUES ($1, 'A', 'draft', $2, $3)",
      [a, JSON.stringify(graph), admin.id],
    );
    await h.ownerPool.query(
      "INSERT INTO instagram_flow_versions (id, flow_id, version, steps, created_by) VALUES ($1, $2, 1, $3, $4)",
      [vid, a, JSON.stringify(graph), admin.id],
    );
    await h.ownerPool.query(
      "UPDATE instagram_flows SET status = 'live', live_version_id = $2 WHERE id = $1",
      [a, vid],
    );
    await h.ownerPool.query(
      `INSERT INTO instagram_triggers (id, flow_id, kind, keywords, mode, media_ids, public_replies, cooldown_hours)
       VALUES ($1, $2, 'dm', '{ping}', 'word', '{}', '{}', 0)`,
      [randomUUID(), a],
    );
    await dm("m1", "ping");
    expect((await runs()).map((r) => r.flow)).toEqual(["A", "B", "A", "B"]);
    const noted = await h.queryAll<{ payload: { problem: string } }>(
      "SELECT payload FROM activities WHERE type = 'instagram_flow_problem'",
    );
    expect(noted.map((n) => n.payload.problem)).toEqual([
      "Flows passed this conversation on too many times in a row.",
    ]);
  });

  it("two flows that send people to each other with a wait between still stop after three hops (review 2026-11-23)", async () => {
    const a = randomUUID();
    const b = await liveFlow(
      "B",
      G(
        "b",
        msg("b", { next: "w" }),
        { id: "w", type: "wait", for: { minutes: 1 }, next: "g" },
        { id: "g", type: "goto", flowId: a },
      ),
      [],
    );
    const vid = randomUUID();
    const graph = G(
      "a",
      msg("a", { next: "w" }),
      { id: "w", type: "wait", for: { minutes: 1 }, next: "g" },
      { id: "g", type: "goto", flowId: b.id },
    );
    await h.ownerPool.query(
      "INSERT INTO instagram_flows (id, name, status, draft_steps, created_by) VALUES ($1, 'A', 'draft', $2, $3)",
      [a, JSON.stringify(graph), admin.id],
    );
    await h.ownerPool.query(
      "INSERT INTO instagram_flow_versions (id, flow_id, version, steps, created_by) VALUES ($1, $2, 1, $3, $4)",
      [vid, a, JSON.stringify(graph), admin.id],
    );
    await h.ownerPool.query(
      "UPDATE instagram_flows SET status = 'live', live_version_id = $2 WHERE id = $1",
      [a, vid],
    );
    await h.ownerPool.query(
      `INSERT INTO instagram_triggers (id, flow_id, kind, keywords, mode, media_ids, public_replies, cooldown_hours)
       VALUES ($1, $2, 'dm', '{ping}', 'word', '{}', '{}', 0)`,
      [randomUUID(), a],
    );
    await dm("m1", "ping");
    for (let i = 0; i < 8; i++) {
      h.clock.advance(2 * 60_000);
      await h.runInstagramFlows();
    }
    expect((await runs()).map((r) => r.flow)).toEqual(["A", "B", "A", "B"]);
    expect(await sentKeys()).toEqual(["a", "b", "a", "b"]);
    const notes = await h.queryAll("SELECT 1 FROM instagram_outbox WHERE step_key = 'note'");
    expect(notes.length).toBeLessThanOrEqual(1);
    const noted = await h.queryAll<{ payload: { problem: string } }>(
      "SELECT payload FROM activities WHERE type = 'instagram_flow_problem'",
    );
    expect(noted.map((n) => n.payload.problem)).toEqual([
      "Flows passed this conversation on too many times in a row.",
    ]);
  });

  it("no answer after two days, past Meta's window: its steps that change the lead still run", async () => {
    await liveFlow(
      "Ask",
      G(
        "q",
        {
          id: "q",
          type: "ask",
          text: "Your email?",
          save: { field: "email", kind: "email" },
          retry: "That doesn't look like an email.",
          next: null,
          noAnswer: { afterMinutes: 2 * 24 * 60, next: "cold" },
        },
        { id: "cold", type: "notify", to: "admins", text: "Went quiet on the quiz", next: null },
      ),
      ["quiz"],
    );
    await dm("m1", "quiz");
    h.clock.advance(25 * H);
    await h.runInstagramFlows();
    expect((await runs())[0]).toMatchObject({ status: "waiting" });
    h.clock.advance(24 * H);
    await h.runInstagramFlows();
    expect((await runs())[0]).toMatchObject({ status: "done" });
    const mine = (await call("GET", "/api/v1/notifications")).json();
    expect((mine.items as { body: string }[]).some((n) => n.body === "Went quiet on the quiz")).toBe(true);
  });

  it("tell a person who can't see the lead: the words reach them, never the lead's name", async () => {
    const rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    await liveFlow(
      "Tell",
      G("n", {
        id: "n",
        type: "notify",
        to: { userId: rep.id },
        text: "Someone asked for prices",
        next: null,
      }),
      ["quiz"],
    );
    await dm("m1", "quiz");
    const theirs = (
      await (await h.signIn(rep)).inject({ method: "GET", url: "/api/v1/notifications" })
    ).json();
    const told = (theirs.items as { title: string; body: string; leadId?: string | null }[]).filter(
      (n) => n.body === "Someone asked for prices",
    );
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toBe("A lead on Instagram");
    expect(told[0]!.leadId ?? null).toBeNull();
  });

  it("Replay's list: who went through it, newest first, each once; a search; only leads the asker may see", async () => {
    const f = await liveFlow("Who", G("hi", msg("hi")), ["quiz"]);
    await dm("m1", "quiz");
    await deliverIg(h, igDm({ mid: "m2", text: "quiz", from: "6512000000000002", at: ts() }));
    await h.runInstagram();
    await dm("m3", "quiz again");
    const leads = await h.queryAll<{ id: string; name: string }>(
      "SELECT id, name FROM leads ORDER BY created_at",
    );
    expect(leads).toHaveLength(2);
    const [first, second] = leads as [{ id: string; name: string }, { id: string; name: string }];
    await h.queryAll("UPDATE leads SET name = $2 WHERE id = $1", [first.id, "Priya Shah"]);
    await h.queryAll("UPDATE leads SET name = $2 WHERE id = $1", [second.id, "Arjun Mehta"]);
    first.name = "Priya Shah";
    const all = (await call("GET", `/api/v1/instagram/flows/${f.id}/people`)).json();
    // The first person wrote again last: they're first, once.
    expect(all.people.map((p: { leadId: string }) => p.leadId)).toEqual([first.id, second.id]);
    expect(all.people[0]).toMatchObject({ name: first.name, status: "done", photo: null });
    // A search reads names, case aside, anywhere in them.
    const found = (await call("GET", `/api/v1/instagram/flows/${f.id}/people?q=MEHT`)).json();
    expect(found.people.map((p: { leadId: string }) => p.leadId)).toEqual([second.id]);
    // Someone who may see only their own leads sees only theirs.
    const rep = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "own" },
        { key: "instagram.flows.manage", scope: null },
      ],
    });
    await h.queryAll("UPDATE leads SET owner_id = $1 WHERE id = $2", [rep.id, second.id]);
    const theirs = (
      await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/instagram/flows/${f.id}/people` })
    ).json();
    expect(theirs.people.map((p: { leadId: string }) => p.leadId)).toEqual([second.id]);
    // Replay counts what a run sent.
    const replay = (await call("GET", `/api/v1/instagram/flows/${f.id}/runs?lead=${first.id}`)).json();
    expect(replay.runs[0].sent).toBe(1);
    // One busy lead (many runs since) hides nobody: each person is listed once, newest first.
    await h.queryAll(
      `INSERT INTO instagram_flow_runs (id, flow_id, version_id, lead_id, thread_id, status, state, started_by, created_at)
       SELECT gen_random_uuid(), flow_id, version_id, lead_id, thread_id, 'done', state, started_by,
              (SELECT max(created_at) FROM instagram_flow_runs) + g * interval '1 second'
         FROM instagram_flow_runs, generate_series(1, 30) g
        WHERE flow_id = $1 AND lead_id = $2 AND status = 'done'
        ORDER BY created_at DESC LIMIT 30`,
      [f.id, first.id],
    );
    const busy = (await call("GET", `/api/v1/instagram/flows/${f.id}/people`)).json();
    expect(busy.people.map((p: { leadId: string }) => p.leadId)).toEqual([first.id, second.id]);
    // Whoever went through it last is first, whatever order the leads were made in.
    await h.queryAll(
      `INSERT INTO instagram_flow_runs (id, flow_id, version_id, lead_id, thread_id, status, state, started_by, created_at)
       SELECT gen_random_uuid(), flow_id, version_id, lead_id, thread_id, 'done', state, started_by,
              (SELECT max(created_at) FROM instagram_flow_runs) + interval '1 hour'
         FROM instagram_flow_runs WHERE flow_id = $1 AND lead_id = $2 LIMIT 1`,
      [f.id, second.id],
    );
    const later = (await call("GET", `/api/v1/instagram/flows/${f.id}/people`)).json();
    expect(later.people.map((p: { leadId: string }) => p.leadId)).toEqual([second.id, first.id]);
    // A lead deleted since isn't listed.
    await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [first.id]);
    const after = (await call("GET", `/api/v1/instagram/flows/${f.id}/people`)).json();
    expect(after.people.map((p: { leadId: string }) => p.leadId)).toEqual([second.id]);
  });

  it("Numbers for the last N days: the business's days, ending today where the business is", async () => {
    const f = await liveFlow("Days", G("hi", msg("hi")), ["quiz"]);
    await dm("m1", "quiz");
    const r = await call("GET", `/api/v1/instagram/flows/${f.id}/stats?days=30`);
    expect(r.statusCode, r.body).toBe(200);
    expect((Date.parse(r.json().to) - Date.parse(r.json().from)) / 86_400_000).toBe(29);
    const both = await call("GET", `/api/v1/instagram/flows/${f.id}/stats?days=30&from=2026-11-01`);
    expect(both.statusCode).toBe(400);
    const none = await call("GET", `/api/v1/instagram/flows/${f.id}/stats`);
    expect(none.statusCode).toBe(400);
    const all3 = await call(
      "GET",
      `/api/v1/instagram/flows/${f.id}/stats?days=30&from=2026-11-01&to=2026-11-02`,
    );
    expect(all3.statusCode).toBe(400);
    // Today is the business's today. Two zones far either side of UTC: at any hour one of them is on another date
    // than UTC, so a range ending on the server's (UTC) day can't pass.
    const was = (await h.queryAll<{ tz: string }>("SELECT timezone AS tz FROM settings WHERE id = 1"))[0]!.tz;
    const day = (tz: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    const seen: string[] = [];
    for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      await h.queryAll("UPDATE settings SET timezone = $1 WHERE id = 1", [tz]);
      const one = (await call("GET", `/api/v1/instagram/flows/${f.id}/stats?days=1`)).json();
      expect(one.to).toBe(day(tz));
      expect(one.from).toBe(one.to);
      seen.push(one.to);
    }
    expect(seen.some((d) => d !== day("UTC"))).toBe(true);
    await h.queryAll("UPDATE settings SET timezone = $1 WHERE id = 1", [was]);
  });

  it("a version copied as a new flow: the copy's draft is that version, not today's draft", async () => {
    const f = await liveFlow("Old", G("hi", msg("hi", { text: "The first words" })), ["quiz"]);
    const v = (await call("GET", `/api/v1/instagram/flows/${f.id}/versions`)).json().versions[0];
    const now = (await call("GET", `/api/v1/instagram/flows/${f.id}`)).json();
    await call("PUT", `/api/v1/instagram/flows/${f.id}`, {
      rev: now.rev,
      graph: G("hi", msg("hi", { text: "Newer words" })),
    });
    const c = await call("POST", `/api/v1/instagram/flows/${f.id}/duplicate`, { versionId: v.id });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().graph.nodes[0].text).toBe("The first words");
    expect(c.json().status).toBe("draft");
    const plain = (await call("POST", `/api/v1/instagram/flows/${f.id}/duplicate`)).json();
    expect(plain.graph.nodes[0].text).toBe("Newer words");
    const other = (await call("POST", "/api/v1/instagram/flows", { name: "Other" })).json();
    const wrong = await call("POST", `/api/v1/instagram/flows/${other.id}/duplicate`, { versionId: v.id });
    expect(wrong.statusCode).toBe(404);
  });

  it("Replay shows a run waiting in its Wait step", async () => {
    const f = await liveFlow(
      "Later",
      G(
        "hi",
        msg("hi", { next: "w" }),
        { id: "w", type: "wait", for: { minutes: 60 }, next: "bye" },
        msg("bye"),
      ),
      ["quiz"],
    );
    await dm("m1", "quiz");
    const lead = (await h.queryAll<{ id: string }>("SELECT id FROM leads"))[0]!.id;
    const replay = (await call("GET", `/api/v1/instagram/flows/${f.id}/runs?lead=${lead}`)).json();
    expect(replay.runs[0].waiting).toMatchObject({ step: "w", why: "time" });
  });

  it("tell my team, and a follow-up: the admins hear the flow's words, and the lead has its task", async () => {
    await liveFlow(
      "Hot",
      G(
        "n",
        { id: "n", type: "notify", to: "admins", text: "Hot lead from the quiz", next: "t" },
        {
          id: "t",
          type: "update",
          actions: [{ kind: "task", title: "Call back today", dueMinutes: 30 }],
          next: null,
        },
      ),
      ["quiz"],
    );
    await dm("m1", "quiz");
    // Read as the admin: notifications are each person's own.
    const mine = (await call("GET", "/api/v1/notifications")).json();
    const told = (mine.items as { title: string; body: string }[]).filter(
      (n: { body: string }) => n.body === "Hot lead from the quiz",
    );
    expect(told.map((n: { title: string; body: string }) => ({ title: n.title, body: n.body }))).toEqual([
      { title: "Priya on Instagram", body: "Hot lead from the quiz" },
    ]);
    const tasks = await h.queryAll<{ title: string }>("SELECT title FROM tasks");
    expect(tasks).toEqual([{ title: "Call back today" }]);
  });
});
