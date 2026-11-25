import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  IG_ACCOUNT,
  IGSID,
  igAdDm,
  igComment,
  igDm,
  igEcho,
  igStoryReply,
} from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliverIg, IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { igPacer, sendInstagramOutbox, TryLater } from "./sender";
import { seedNumber } from "../../../test/whatsapp";

/**
 * Flows at work (plan 1B Tasks 4–5; spec 2026-11-22 §2, the who-answers rule): a trigger starts a run, the person's
 * messages advance it, a person taking over stops it; every send once, never outside Meta's window.
 */
const H = 3_600_000;
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
let account: { id: string; sourceId: string };

const ts = () => h.clock.now.toISOString();
const outbox = () =>
  h.queryAll<{ kind: string; text: string; step_key: string; status: string; comment_id: string | null }>(
    "SELECT kind, text, step_key, status, comment_id FROM instagram_outbox ORDER BY created_at, id",
  );
const runs = () =>
  h.queryAll<{ status: string; reason: string | null; keyword: string | null; flow: string }>(
    `SELECT r.status, r.reason, r.keyword, f.name AS flow FROM instagram_flow_runs r
       JOIN instagram_flows f ON f.id = r.flow_id ORDER BY r.created_at`,
  );

/** A live flow with these steps and triggers, published straight in the tables (the API is tested on its own). */
async function liveFlow(
  name: string,
  steps: unknown[],
  trigger: Partial<{
    kind: string;
    keywords: string[];
    mode: string;
    media: string[];
    cooldown: number;
  }> = {},
  priority = 0,
) {
  const id = randomUUID();
  const vid = randomUUID();
  await h.ownerPool.query(
    "INSERT INTO instagram_flows (id, name, status, priority, draft_steps, created_by) VALUES ($1, $2, 'draft', $3, $4, $5)",
    [id, name, priority, JSON.stringify(steps), admin.id],
  );
  await h.ownerPool.query(
    "INSERT INTO instagram_flow_versions (id, flow_id, version, steps, created_by) VALUES ($1, $2, 1, $3, $4)",
    [vid, id, JSON.stringify(steps), admin.id],
  );
  await h.ownerPool.query("UPDATE instagram_flows SET status = 'live', live_version_id = $2 WHERE id = $1", [
    id,
    vid,
  ]);
  await h.ownerPool.query(
    `INSERT INTO instagram_triggers (id, flow_id, kind, keywords, mode, media_ids, public_replies, cooldown_hours)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      id,
      trigger.kind ?? "comment",
      trigger.keywords ?? ["guide"],
      trigger.mode ?? "word",
      trigger.media ?? [],
      trigger.kind === "comment" || !trigger.kind ? ["Sent you a DM!"] : [],
      trigger.cooldown ?? 24,
    ],
  );
  return { id, vid };
}

const magnet = [
  {
    id: "hello",
    type: "send",
    text: "Here's the guide!",
    quickReplies: [{ title: "Send it", payload: "go" }],
  },
  {
    id: "email",
    type: "ask",
    text: "What's your email?",
    save: { field: "email", kind: "email" },
    fallback: "Try again?",
  },
  { id: "bye", type: "send", text: "Done! Check your inbox." },
];

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
  });
  h.setRelayUrl("https://relay.test");
  h.clock.now = new Date("2026-11-22T06:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  h.clock.advance(H);
  await h.ownerPool.query(
    "TRUNCATE leads, activities, instagram_threads, instagram_events, instagram_comments, instagram_outbox, instagram_flows, notifications CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  h.instagramQueued.length = 0;
  h.instagramPublicQueued.length = 0;
  h.instagramSendQueued.length = 0;
  ig.sent.length = 0;
  ig.failNext.length = 0;
  ig.tokens.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  ig.profiles.set(IGSID, { name: "Priya Shah", username: "priya.fit" });
  account = await seedIgAccount(h, { runAs: admin.id });
});

describe("a keyword comment", () => {
  it("one private reply, a public reply, a lead; the same comment again does nothing more", async () => {
    await liveFlow("Lead magnet", magnet);
    const body = igComment({ text: "GUIDE please", time: Math.floor(h.clock.now.getTime() / 1000) });
    await deliverIg(h, body);
    await deliverIg(h, body);
    await h.runInstagram();
    expect(await outbox()).toEqual([
      expect.objectContaining({
        kind: "private_reply",
        text: "Here's the guide!",
        step_key: "hello",
        status: "queued",
      }),
    ]);
    expect(h.instagramPublicQueued).toHaveLength(1);
    expect(await runs()).toEqual([
      { status: "waiting", reason: null, keyword: "guide", flow: "Lead magnet" },
    ]);
    const kinds = await h.queryAll<{ kind: string }>("SELECT kind FROM instagram_flow_events ORDER BY id");
    expect(kinds.map((k) => k.kind)).toEqual(["triggered", "lead_created", "private_reply"]);
    expect(await h.queryAll("SELECT 1 FROM leads WHERE deleted_at IS NULL")).toHaveLength(1);
  });

  it("a comment without the keyword, or on another post the trigger doesn't cover, starts nothing", async () => {
    await liveFlow("Lead magnet", magnet, { media: ["17980000000000999"] });
    await deliverIg(h, igComment({ id: "1", text: "GUIDE", time: Math.floor(h.clock.now.getTime() / 1000) }));
    await liveFlow("Other", magnet, { keywords: ["price"] });
    await deliverIg(
      h,
      igComment({ id: "2", text: "nice reel", time: Math.floor(h.clock.now.getTime() / 1000) }),
    );
    await h.runInstagram();
    expect(await runs()).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it("the person answers: the automated note once, then the flow goes on in their inbox", async () => {
    await liveFlow("Lead magnet", magnet);
    await deliverIg(h, igComment({ time: Math.floor(h.clock.now.getTime() / 1000) }));
    await h.runInstagram();
    await deliverIg(h, igDm({ mid: "q1", text: "Send it", quick_reply: { payload: "go" }, at: ts() }));
    await h.runInstagram();
    await deliverIg(h, igDm({ mid: "q2", text: "Priya@Example.test", at: ts() }));
    await h.runInstagram();
    expect((await outbox()).map((o) => [o.kind, o.step_key])).toEqual([
      ["private_reply", "hello"],
      ["dm", "note"],
      ["dm", "email"],
      ["dm", "bye"],
    ]);
    const [lead] = await h.queryAll<{ email: string }>("SELECT email FROM leads");
    expect(lead!.email).toBe("priya@example.test");
    expect((await runs())[0]).toMatchObject({ status: "done" });
  });
});

describe("who answers (spec §2)", () => {
  it("row 1: a person took the conversation over: no flow starts; one running stops when they write", async () => {
    await liveFlow("DM flow", magnet, { kind: "dm", keywords: ["course"] });
    await deliverIg(h, igDm({ mid: "a", text: "Hi, the course?", at: ts() }));
    await h.runInstagram();
    expect((await runs())[0]).toMatchObject({ status: "waiting" });
    await deliverIg(h, igEcho({ mid: "e1", text: "Hi Priya, it's Sam", at: ts() }));
    await h.runInstagram();
    expect((await runs())[0]).toMatchObject({
      status: "stopped",
      reason: "A person took this conversation over.",
    });
    await deliverIg(h, igDm({ mid: "b", text: "course again", at: ts() }));
    await h.runInstagram();
    expect(await runs()).toHaveLength(1);
  });

  it("row 1: taken over before any flow: a keyword starts nothing", async () => {
    await liveFlow("DM flow", magnet, { kind: "dm", keywords: ["course"] });
    await deliverIg(h, igDm({ mid: "a", text: "hello", at: ts() }));
    await h.runInstagram();
    const [t] = await h.queryAll<{ id: string }>("SELECT id FROM instagram_threads");
    const r = await (
      await h.signIn(admin)
    ).inject({ method: "POST", url: `/api/v1/instagram/threads/${t!.id}/take-over` });
    expect(r.statusCode).toBe(200);
    await deliverIg(h, igDm({ mid: "b", text: "the course?", at: ts() }));
    await h.runInstagram();
    expect(await runs()).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it("row 2: LUME AI holds the lead: no flow starts", async () => {
    await liveFlow("DM flow", magnet, { kind: "dm", keywords: ["course"] });
    await deliverIg(h, igDm({ mid: "a", text: "hello", at: ts() }));
    await h.runInstagram();
    const [lead] = await h.queryAll<{ id: string }>("SELECT id FROM leads");
    const number = await seedNumber(h, { runAs: admin.id });
    const run = randomUUID();
    await h.ownerPool.query(
      `INSERT INTO autopilot_runs (id, name, started_by, speaker_id, number_id, goal, permissions, follow_up_days, outside_hours)
       VALUES ($1, 'Run', $2, $2, $3, '{"kind":"reply"}', '{}', '{2}', 'wait')`,
      [run, admin.id, number],
    );
    await h.queryAll(
      "INSERT INTO autopilot_leads (run_id, lead_id, state, active) VALUES ($1, $2, 'talking', true)",
      [run, lead!.id],
    );
    await deliverIg(h, igDm({ mid: "b", text: "the course?", at: ts() }));
    await h.runInstagram();
    expect(await runs()).toEqual([]);
  });

  it("rows 3–4: two flows match one DM: the keyword beats 'any', then priority; a person in a run stays in it", async () => {
    await liveFlow("Any DM", magnet, { kind: "dm", mode: "any", keywords: [] }, 10);
    await liveFlow("Course", [{ id: "c", type: "send", text: "About the course…" }], {
      kind: "dm",
      keywords: ["course"],
    });
    await deliverIg(h, igDm({ mid: "a", text: "the course?", at: ts() }));
    await h.runInstagram();
    expect((await runs()).map((r) => r.flow)).toEqual(["Course"]);
    await deliverIg(h, igDm({ mid: "b", text: "and prices?", at: ts() }));
    await h.runInstagram();
    // "Course" finished at once; "Any DM" picks up the next message.
    expect((await runs()).map((r) => [r.flow, r.status])).toEqual([
      ["Course", "done"],
      ["Any DM", "waiting"],
    ]);
  });

  it("row 6: nothing matches: the team has it, nothing automated goes", async () => {
    await liveFlow("Course", magnet, { kind: "dm", keywords: ["course"] });
    await deliverIg(h, igDm({ mid: "a", text: "hello there", at: ts() }));
    await h.runInstagram();
    expect(await runs()).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it("stop: the lead is do-not-contact and the run stops before anything else goes", async () => {
    await liveFlow("DM flow", magnet, { kind: "dm", keywords: ["course"] });
    await deliverIg(h, igDm({ mid: "a", text: "course", at: ts() }));
    await h.runInstagram();
    await deliverIg(h, igDm({ mid: "b", text: "STOP", at: ts() }));
    await h.runInstagram();
    expect((await runs())[0]).toMatchObject({ status: "stopped" });
    expect((await outbox()).filter((o) => o.step_key === "email:fallback")).toEqual([]);
  });

  it("the person's word for a person hands over, and the owner hears", async () => {
    await liveFlow("DM flow", magnet, { kind: "dm", keywords: ["course"] });
    await deliverIg(h, igDm({ mid: "a", text: "course", at: ts() }));
    await h.runInstagram();
    await deliverIg(h, igDm({ mid: "b", text: "person", at: ts() }));
    await h.runInstagram();
    expect((await runs())[0]).toMatchObject({ status: "handed" });
    const acts = await h.queryAll<{ type: string }>(
      "SELECT type FROM activities WHERE type = 'instagram_flow_handed'",
    );
    expect(acts).toHaveLength(1);
  });
});

describe("review fixes", () => {
  it("a comment older than Meta's 7 days (a gap caught up late) starts nothing", async () => {
    await liveFlow("Lead magnet", magnet);
    const old = Math.floor((h.clock.now.getTime() - 8 * 24 * H) / 1000);
    await deliverIg(h, igComment({ text: "guide", time: old }));
    await h.runInstagram();
    expect(await runs()).toEqual([]);
    expect(h.instagramPublicQueued).toEqual([]);
    expect(await h.queryAll("SELECT 1 FROM leads")).toHaveLength(0);
  });

  it("public replies under comments: so many an hour per account, the private replies unaffected", async () => {
    await liveFlow("Lead magnet", magnet);
    const was = h.deps.instagramLimits;
    h.deps.instagramLimits = { perSecond: 20, privateRepliesPerHour: 1 };
    try {
      const t = Math.floor(h.clock.now.getTime() / 1000);
      await deliverIg(h, igComment({ id: "1", text: "guide", time: t }));
      await deliverIg(
        h,
        igComment({ id: "2", from: "6512000000000002", username: "ana", text: "guide", time: t }),
      );
      await h.runInstagram();
    } finally {
      h.deps.instagramLimits = was;
    }
    expect(h.instagramPublicQueued).toHaveLength(1);
    expect((await outbox()).filter((o) => o.kind === "private_reply")).toHaveLength(2);
  });

  it("a story reply starts the story flow, even when its words are a DM flow's keyword", async () => {
    await liveFlow("Love", [{ id: "p", type: "send", text: "Glad you like it" }], {
      kind: "dm",
      keywords: ["love"],
    });
    await liveFlow("Story thanks", [{ id: "t", type: "send", text: "Thanks!" }], {
      kind: "story_reply",
      keywords: [],
    });
    await deliverIg(h, igStoryReply());
    await h.runInstagram();
    expect((await runs()).map((r) => r.flow)).toEqual(["Story thanks"]);
  });

  it("a plain DM later from someone who once came from an ad doesn't start the ad flow again", async () => {
    await liveFlow("Ad welcome", [{ id: "w", type: "send", text: "Welcome!" }], {
      kind: "ad",
      keywords: [],
      cooldown: 0,
    });
    await deliverIg(h, igAdDm());
    await h.runInstagram();
    await deliverIg(h, igDm({ mid: "later", text: "hi again", at: ts() }));
    await h.runInstagram();
    expect((await runs()).map((r) => r.flow)).toEqual(["Ad welcome"]);
  });

  it("archived with private replies still queued: they're cancelled with words, and none goes", async () => {
    const f = await liveFlow("Lead magnet", magnet);
    await deliverIg(h, igComment({ text: "guide", time: Math.floor(h.clock.now.getTime() / 1000) }));
    await h.runInstagram();
    const r = await (
      await h.signIn(admin)
    ).inject({ method: "POST", url: `/api/v1/instagram/flows/${f.id}/archive` });
    expect(r.json()).toMatchObject({ stopped: 1 });
    expect(await outbox()).toEqual([expect.objectContaining({ status: "cancelled" })]);
    await h.runInstagramSend();
    expect(ig.sent).toHaveLength(0);
    const [c] = await h.queryAll<{ private_reply: string }>("SELECT private_reply FROM instagram_comments");
    expect(c!.private_reply).toBe("failed");
  });

  it("the account disconnected: its waiting runs stop with words at the next sweep", async () => {
    await liveFlow(
      "Nudge",
      [
        { id: "w", type: "wait", minutes: 60 },
        { id: "s", type: "send", text: "Hi" },
      ],
      {
        kind: "dm",
        keywords: ["course"],
      },
    );
    await deliverIg(h, igDm({ mid: "a", text: "course", at: ts() }));
    await h.runInstagram();
    await h.ownerPool.query("UPDATE instagram_accounts SET status = 'disconnected', token_enc = NULL");
    h.clock.advance(2 * H);
    await h.runInstagramFlows();
    expect((await runs())[0]).toMatchObject({
      status: "stopped",
      reason: "The Instagram account was disconnected.",
    });
  });

  it("whoever connected the account can't see leads any more: runs stop with words, never blocking the sweep", async () => {
    const lost = await h.seedUser({ grants: [{ key: "leads.create", scope: "own" }] });
    await liveFlow(
      "Nudge",
      [
        { id: "w", type: "wait", minutes: 60 },
        { id: "s", type: "send", text: "Hi" },
      ],
      {
        kind: "dm",
        keywords: ["course"],
      },
    );
    await deliverIg(h, igDm({ mid: "a", text: "course", at: ts() }));
    await h.runInstagram();
    await h.ownerPool.query("UPDATE instagram_accounts SET run_as = $1", [lost.id]);
    h.clock.advance(2 * H);
    await h.runInstagramFlows();
    expect((await runs())[0]).toMatchObject({
      status: "stopped",
      reason: "Whoever connected this Instagram account can't see leads any more.",
    });
  });

  it("a first DM after a comment flow still counts as their first message", async () => {
    await liveFlow("Lead magnet", [{ id: "h", type: "send", text: "Here!" }]);
    await liveFlow("Welcome", [{ id: "w", type: "send", text: "Welcome!" }], {
      kind: "welcome",
      keywords: [],
    });
    await deliverIg(h, igComment({ text: "guide", time: Math.floor(h.clock.now.getTime() / 1000) }));
    await h.runInstagram();
    // The comment flow waits for them; it ends when Meta's 7 days for the reply pass.
    h.clock.advance(8 * 24 * H);
    await h.runInstagramFlows();
    await deliverIg(h, igDm({ mid: "first", text: "hello", at: ts() }));
    await h.runInstagram();
    expect((await runs()).map((r) => r.flow)).toEqual(["Lead magnet", "Welcome"]);
  });

  it("Meta's data deletion forgets what people answered in flows", async () => {
    await liveFlow("DM flow", magnet, { kind: "dm", keywords: ["course"] });
    await deliverIg(h, igDm({ mid: "a", text: "course", at: ts() }));
    await h.runInstagram();
    await deliverIg(h, igDm({ mid: "b", text: "me@example.test", at: ts() }));
    await h.runInstagram();
    await h.queryAll("SELECT lume_instagram_forget($1)", [account.id]);
    const [r] = await h.queryAll<{ answers: unknown }>(
      "SELECT state->'answers' AS answers FROM instagram_flow_runs",
    );
    expect(r!.answers).toEqual({});
  });
});

describe("once at a time", () => {
  it("the cool-down: the keyword again within it starts nothing; after it, the flow starts again", async () => {
    await liveFlow("Price", [{ id: "p", type: "send", text: "Prices are on our site." }], {
      kind: "dm",
      keywords: ["price"],
      cooldown: 24,
    });
    await deliverIg(h, igDm({ mid: "a", text: "price?", at: ts() }));
    await h.runInstagram();
    h.clock.advance(H);
    await deliverIg(h, igDm({ mid: "b", text: "price again?", at: ts() }));
    await h.runInstagram();
    expect(await runs()).toHaveLength(1);
    h.clock.advance(24 * H);
    await deliverIg(h, igDm({ mid: "c", text: "price now?", at: ts() }));
    await h.runInstagram();
    expect((await runs()).map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("someone in one flow who comments another's keyword stays where they are: no second run, no private reply", async () => {
    await liveFlow("DM flow", magnet, { kind: "dm", keywords: ["course"] });
    await liveFlow("Lead magnet", magnet);
    await deliverIg(h, igDm({ mid: "a", text: "course", at: ts() }));
    await h.runInstagram();
    await deliverIg(h, igComment({ text: "guide", time: Math.floor(h.clock.now.getTime() / 1000) }));
    await h.runInstagram();
    expect((await runs()).map((r) => r.flow)).toEqual(["DM flow"]);
    expect((await outbox()).filter((o) => o.kind === "private_reply")).toEqual([]);
    // The comment itself is kept, and its delivery done (not failing over and over).
    expect(await h.queryAll("SELECT 1 FROM instagram_comments")).toHaveLength(1);
    expect(await h.queryAll("SELECT status FROM instagram_events ORDER BY id")).toEqual([
      { status: "done" },
      { status: "done" },
    ]);
  });

  it("a flow archived while someone is in it: their next message stops it, saying why, and nothing goes", async () => {
    const f = await liveFlow("DM flow", magnet, { kind: "dm", keywords: ["course"] });
    await deliverIg(h, igDm({ mid: "a", text: "course", at: ts() }));
    await h.runInstagram();
    const before = (await outbox()).length;
    await h.ownerPool.query("UPDATE instagram_flows SET status = 'archived' WHERE id = $1", [f.id]);
    await deliverIg(h, igDm({ mid: "b", text: "me@example.test", at: ts() }));
    await h.runInstagram();
    expect((await runs())[0]).toMatchObject({ status: "stopped", reason: "This flow was archived." });
    expect(await outbox()).toHaveLength(before);
  });
});

describe("versions and time", () => {
  it("a new version: conversations in the flow finish on theirs; new ones start on the new one", async () => {
    const f = await liveFlow("DM flow", magnet, { kind: "dm", keywords: ["course"] });
    await deliverIg(h, igDm({ mid: "a", text: "course", at: ts() }));
    await h.runInstagram();
    const v2 = randomUUID();
    const steps2 = [{ id: "v2", type: "send", text: "New welcome" }];
    await h.ownerPool.query(
      "INSERT INTO instagram_flow_versions (id, flow_id, version, steps, created_by) VALUES ($1, $2, 2, $3, $4)",
      [v2, f.id, JSON.stringify(steps2), admin.id],
    );
    await h.ownerPool.query("UPDATE instagram_flows SET live_version_id = $2 WHERE id = $1", [f.id, v2]);
    await deliverIg(h, igDm({ mid: "b", text: "me@example.test", at: ts() }));
    await h.runInstagram();
    expect((await outbox()).map((o) => o.step_key)).toContain("bye");
    ig.profiles.set("6512000000000002", { name: "Ana", username: "ana" });
    await deliverIg(h, igDm({ mid: "c", from: "6512000000000002", text: "course", at: ts() }));
    await h.runInstagram();
    expect((await outbox()).map((o) => o.step_key)).toContain("v2");
  });

  it("a wait sends when its time comes; a person waited on past Meta's 24 hours ends the run with words", async () => {
    await liveFlow(
      "Nudge",
      [
        { id: "w", type: "wait", minutes: 60 },
        { id: "s", type: "send", text: "Still keen?" },
        { id: "q", type: "ask", text: "Email?", save: { field: "email", kind: "email" }, fallback: "Again?" },
      ],
      { kind: "dm", keywords: ["course"] },
    );
    await deliverIg(h, igDm({ mid: "a", text: "course", at: ts() }));
    await h.runInstagram();
    expect(await outbox()).toEqual([]);
    h.clock.advance(61 * 60_000);
    await h.runInstagramFlows();
    expect((await outbox()).map((o) => o.step_key)).toEqual(["note", "s", "q"]);
    h.clock.advance(24 * H);
    await h.runInstagramFlows();
    expect((await runs())[0]).toMatchObject({
      status: "done",
      reason: "The person didn't answer while Instagram allowed a reply.",
    });
  });
});

describe("what a flow brought", () => {
  it("by keyword over the business's days: started, private replies, replies, leads", async () => {
    const f = await liveFlow("Lead magnet", magnet, { keywords: ["guide", "free"] });
    const t = Math.floor(h.clock.now.getTime() / 1000);
    await deliverIg(h, igComment({ id: "1", text: "guide", time: t }));
    await deliverIg(
      h,
      igComment({ id: "2", from: "6512000000000002", username: "ana", text: "FREE?", time: t }),
    );
    await h.runInstagram();
    await deliverIg(h, igDm({ mid: "r1", text: "Send it", quick_reply: { payload: "go" }, at: ts() }));
    await h.runInstagram();
    // The business's day may differ from UTC's: a range of three days around now holds it either way.
    const day = (d: number) => new Date(h.clock.now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
    const r = await (
      await h.signIn(admin)
    ).inject({
      method: "GET",
      url: `/api/v1/instagram/flows/${f.id}/stats?from=${day(-1)}&to=${day(1)}`,
    });
    expect(r.json().total).toMatchObject({ triggered: 2, privateReplies: 2, replied: 1, leads: 2 });
    expect(
      r
        .json()
        .byKeyword.map((k: { keyword: string }) => k.keyword)
        .sort(),
    ).toEqual(["free", "guide"]);
    const bad = await (
      await h.signIn(admin)
    ).inject({
      method: "GET",
      url: `/api/v1/instagram/flows/${f.id}/stats?from=2026-02-30&to=2026-03-01`,
    });
    expect(bad.json().error.message).toBe("Choose real days.");
  });
  it("only messages that went count: one Meta refused, and a stopped run's queued one, drop out", async () => {
    const f = await liveFlow("Lead magnet", magnet);
    const t = Math.floor(h.clock.now.getTime() / 1000);
    await deliverIg(h, igComment({ id: "1", text: "guide", time: t }));
    await deliverIg(
      h,
      igComment({ id: "2", from: "6512000000000002", username: "ana", text: "guide", time: t }),
    );
    await deliverIg(
      h,
      igComment({ id: "3", from: "6512000000000003", username: "raj", text: "guide", time: t }),
    );
    await h.runInstagram();
    const o = {
      app: h.app,
      d: h.deps,
      pacer: igPacer({ now: () => h.clock.now, perSecond: 10_000 }),
      privateRepliesPerHour: 600,
    };
    const ids = h.instagramSendQueued.splice(0);
    expect(ids).toHaveLength(3);
    // Meta refuses the first (outside its window), the second goes, the third is still queued when the flow is archived.
    ig.failNext.push({ code: 10, subcode: 2534022 });
    await sendInstagramOutbox(o, ids[0]!);
    await sendInstagramOutbox(o, ids[1]!);
    const admin1 = await h.signIn(admin);
    await admin1.inject({ method: "POST", url: `/api/v1/instagram/flows/${f.id}/archive` });
    expect((await outbox()).map((x) => x.status).sort()).toEqual(["cancelled", "failed", "sent"]);
    const day = (d: number) => new Date(h.clock.now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
    const r = await admin1.inject({
      method: "GET",
      url: `/api/v1/instagram/flows/${f.id}/stats?from=${day(-1)}&to=${day(1)}`,
    });
    expect(r.json().total).toMatchObject({ triggered: 3, privateReplies: 1 });
  });
});

describe("every flow's numbers at once (plan 2026-11-25-instagram-screens D3)", () => {
  it("each flow's totals over the business's days, in one answer; a flow with none says zeros", async () => {
    // Months past the real date: the server's clock decides "the last 7 days", never the machine's.
    h.clock.now = new Date(Math.max(h.clock.now.getTime(), Date.parse("2027-06-01T06:00:00Z")));
    const magnetFlow = await liveFlow("Lead magnet", magnet, { keywords: ["guide"] });
    const quiet = await liveFlow("Quiet one", magnet, { keywords: ["quiet"] });
    const t = Math.floor(h.clock.now.getTime() / 1000);
    await deliverIg(h, igComment({ id: "1", text: "guide", time: t }));
    await deliverIg(
      h,
      igComment({ id: "2", from: "6512000000000002", username: "ana", text: "guide", time: t }),
    );
    await h.runInstagram();
    const admin1 = await h.signIn(admin);
    const r = await admin1.inject({ method: "GET", url: "/api/v1/instagram/flows/summary?days=7" });
    expect(r.statusCode, r.body).toBe(200);
    const byId = Object.fromEntries(
      r.json().flows.map((f: { id: string; triggered: number; leads: number }) => [f.id, f]),
    );
    expect(byId[magnetFlow.id]).toMatchObject({ triggered: 2, leads: 2, handed: 0, booked: 0, won: 0 });
    expect(byId[quiet.id]).toMatchObject({ triggered: 0, leads: 0, handed: 0, booked: 0, won: 0 });
    expect(r.json().total).toMatchObject({ triggered: 2, leads: 2 });
    expect(r.json().to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The same range rules as one flow's numbers.
    const bad = await admin1.inject({ method: "GET", url: "/api/v1/instagram/flows/summary?days=400" });
    expect(bad.statusCode).toBe(400);
    const both = await admin1.inject({
      method: "GET",
      url: "/api/v1/instagram/flows/summary?days=7&from=2026-01-01",
    });
    expect(both.json().error.message).toBe("Choose the days: a start and an end, or how many days back.");
  });

  it("someone who can't build flows can't read them", async () => {
    const rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
    const r = await (
      await h.signIn(rep)
    ).inject({ method: "GET", url: "/api/v1/instagram/flows/summary?days=7" });
    expect(r.statusCode).toBe(403);
  });
});

describe("the scale bar", () => {
  it("650 keyword comments on one reel in a burst: one run and one private reply each, paced at 600 an hour", async () => {
    await liveFlow("Lead magnet", magnet);
    const t = Math.floor(h.clock.now.getTime() / 1000);
    const entries = Array.from({ length: 650 }, (_, i) => {
      const who = String(6512000100000000 + i);
      return igComment({
        id: `1799${String(i).padStart(13, "0")}`,
        from: who,
        username: `p${i}`,
        text: "guide!",
        time: t,
      }).entry[0];
    });
    await deliverIg(h, { object: "instagram", entry: entries });
    await h.runInstagram();
    const sent = await h.queryAll<{ n: number; d: number }>(
      "SELECT count(*)::int AS n, count(DISTINCT comment_id)::int AS d FROM instagram_outbox WHERE kind = 'private_reply'",
    );
    expect(sent[0]).toEqual({ n: 650, d: 650 });
    expect(await h.queryAll("SELECT 1 FROM instagram_flow_runs")).toHaveLength(650);
    // Each tried once with room every second: Meta's hour allows 600 private replies; the other 50 wait their turn.
    const o = {
      app: h.app,
      d: h.deps,
      pacer: igPacer({ now: () => h.clock.now, perSecond: 10_000 }),
      privateRepliesPerHour: 600,
    };
    let later = 0;
    for (const id of h.instagramSendQueued.splice(0))
      await sendInstagramOutbox(o, id).catch((e: unknown) => {
        if (!(e instanceof TryLater)) throw e;
        later++;
      });
    expect(ig.sent.filter((x) => x.accountId === IG_ACCOUNT)).toHaveLength(600);
    expect(later).toBe(50);
    expect(await h.queryAll("SELECT 1 FROM instagram_outbox WHERE status = 'queued'")).toHaveLength(50);
  }, 180_000);
});
