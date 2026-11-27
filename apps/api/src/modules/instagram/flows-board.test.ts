import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";

/**
 * The Flows board (plan 2026-11-25-instagram-screens D6b-2): every flow's numbers and, across them, conversations
 * started by what started them, finished, leads, calls and wins (money only for someone who sees it), the first
 * answer's median, those passed to the team and the team's answer, those passed on whom nobody answered within 24
 * hours, those who asked to stop, the posts and ads that started them, and what LUME noticed.
 */
let h: Harness;
let admin: SeededUser;
let account: { id: string };
const TZ = "Asia/Kolkata";
const S = 1000;
const HOUR = 3600 * S;
let n = 0;

type Summary = {
  total: {
    triggered: number;
    finished: number;
    leads: number;
    handed: number;
    booked: number;
    won: number;
    revenue: number | null;
    firstAnswerSec: number | null;
    teamAnswerSec: number | null;
    ranOut: number;
    stopped: number;
  };
  flows: {
    id: string;
    triggered: number;
    finished: number;
    leads: number;
    won: number;
    revenue: number | null;
  }[];
  series: ({ day: string } & Record<string, number>)[];
  sources: { kind: string; id: string; conversations: number; leads: number }[];
  sourcesByFlow: { flowId: string; kind: string; id: string; conversations: number; leads: number }[];
  notes: { id: string; title: string; body: string; flowId?: string }[];
};
const summary = async (u: SeededUser, q = "from=2026-06-01&to=2026-06-30") => {
  const r = await (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/instagram/flows/summary?${q}` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Summary;
};
const day = (d: number, hourUtc = 6) => new Date(Date.UTC(2026, 5, d, hourUtc));

async function flow(name: string) {
  const id = randomUUID();
  const vid = randomUUID();
  const steps = [{ id: "hello", type: "send", text: "Hi!" }];
  await h.ownerPool.query(
    "INSERT INTO instagram_flows (id, name, status, priority, draft_steps, created_by) VALUES ($1, $2, 'draft', 0, $3, $4)",
    [id, name, JSON.stringify(steps), admin.id],
  );
  await h.ownerPool.query(
    "INSERT INTO instagram_flow_versions (id, flow_id, version, steps, created_by) VALUES ($1, $2, 1, $3, $4)",
    [vid, id, JSON.stringify(steps), admin.id],
  );
  await h.ownerPool.query("UPDATE instagram_flows SET status = 'live', live_version_id = $2 WHERE id = $1", [
    id,
    vid,
  ]);
  return { id, vid };
}

/** One run of a flow started at `at`: what it did, as its events and the lead's messages. */
async function run(
  f: { id: string; vid: string },
  o: {
    at: Date;
    by?: string;
    status?: "done" | "handed" | "stopped" | "running";
    reason?: string;
    sent?: number;
    lead?: boolean;
    handed?: number;
    team?: number;
    adId?: string;
    media?: { id: string; type: string };
  },
) {
  const leadId = await h.seedLead({ ownerId: admin.id });
  const thread = randomUUID();
  await h.queryAll(
    "INSERT INTO instagram_threads (id, account_id, igsid, lead_id, source, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
    [
      thread,
      account.id,
      `65120000${++n}`,
      leadId,
      JSON.stringify(
        o.adId ? { trigger: "ad", adId: o.adId } : o.by === "comment" ? { trigger: "comment" } : {},
      ),
      o.at,
    ],
  );
  if (o.media)
    await h.queryAll(
      `INSERT INTO instagram_comments (id, account_id, comment_id, media_id, media_type, from_igsid, at, thread_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, '6512', $5, $6)`,
      [account.id, `c${n}`, o.media.id, o.media.type, o.at, thread],
    );
  const id = randomUUID();
  await h.queryAll(
    `INSERT INTO instagram_flow_runs (id, flow_id, version_id, thread_id, lead_id, status, reason, state, started_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9)`,
    [id, f.id, f.vid, thread, leadId, o.status ?? "done", o.reason ?? null, o.by ?? "dm", o.at],
  );
  const event = (kind: string, after: number, step: string | null = null) =>
    h.queryAll(
      "INSERT INTO instagram_flow_events (flow_id, version_id, run_id, step_key, kind, lead_id, at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [f.id, f.vid, id, step, kind, leadId, new Date(o.at.getTime() + after)],
    );
  await event("triggered", 0);
  if (o.sent !== undefined) await event("dm_sent", o.sent, "hello");
  if (o.lead) await event("lead_created", 2 * S, "lead");
  if (o.handed !== undefined) {
    await event("handed", o.handed, "pass");
    if (o.team !== undefined)
      await h.queryAll(
        `INSERT INTO activities (id, lead_id, type, occurred_at, payload) VALUES (gen_random_uuid(), $1, 'instagram_confirmed_sent', $2, $3::jsonb)`,
        [
          leadId,
          new Date(o.at.getTime() + o.handed + o.team),
          JSON.stringify({ via: "lume", threadId: thread }),
        ],
      );
  }
  return { id, leadId };
}

beforeAll(async () => {
  h = await createHarness({ oauth: { relayToken: IG_RELAY_TOKEN } });
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  h.clock.now = new Date("2026-06-30T12:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.ownerPool.query(
    "TRUNCATE leads, activities, instagram_threads, instagram_comments, instagram_flows, meetings CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  account = await seedIgAccount(h, { runAs: admin.id });
});

describe("the Flows board", () => {
  it("an empty range: zeros, the timings null (dashes), every day there, no notes", async () => {
    await flow("Lead magnet");
    const b = await summary(admin);
    expect(b.total).toMatchObject({
      triggered: 0,
      finished: 0,
      firstAnswerSec: null,
      teamAnswerSec: null,
      ranOut: 0,
    });
    expect(b.series).toHaveLength(30);
    expect(b.notes).toEqual([]);
    expect(b.flows).toMatchObject([{ triggered: 0, finished: 0, revenue: 0 }]);
  });

  it("started by what started them, on the business's days; a flow another started isn't a new conversation", async () => {
    const f = await flow("Lead magnet");
    // 19:00 UTC on June 2 is June 3 in India.
    await run(f, { at: day(2, 19), by: "comment" });
    await run(f, { at: day(3), by: "dm" });
    await run(f, { at: day(3), by: "story_reply" });
    await run(f, { at: day(4), by: "ad", adId: "120200000000001" });
    await run(f, { at: day(4), by: "goto" });
    const b = await summary(admin);
    expect(b.total.triggered).toBe(4);
    expect(b.flows[0]!.triggered).toBe(5);
    expect(b.series.find((d) => d.day === "2026-06-03")).toMatchObject({ comment: 1, dm: 1, story: 1 });
    expect(b.series.find((d) => d.day === "2026-06-04")).toMatchObject({ ad: 1, dm: 0 });
  });

  it("finished, leads, the first answer's median, passed on and the team's answer, and who waited past 24 hours", async () => {
    const f = await flow("Qualify and book");
    await run(f, { at: day(10), sent: 2 * S, lead: true });
    // Ended without reaching the end: on to another flow, or nobody answered its question.
    await run(f, { at: day(10), sent: 2 * S, reason: "went to another flow" });
    await run(f, { at: day(10), sent: 2 * S, reason: "no answer" });
    // Started by an ad click: 7 days to answer, so the team's answer 30 hours on is in time.
    await run(f, { at: day(14), by: "ad", sent: 2 * S, status: "handed", handed: 60 * S, team: 30 * HOUR });
    await run(f, { at: day(11), sent: 4 * S, status: "handed", handed: 60 * S, team: 10 * 60 * S });
    await run(f, { at: day(12), sent: 6 * S, status: "handed", handed: 60 * S, team: 30 * HOUR });
    await run(f, { at: day(13), status: "handed", handed: 60 * S });
    // Passed on two hours ago: still inside the 24 hours, not "waited past".
    await run(f, { at: new Date(h.clock.now.getTime() - 3 * HOUR), status: "handed", handed: HOUR });
    const b = await summary(admin);
    expect(b.total).toMatchObject({
      triggered: 8,
      finished: 1,
      leads: 1,
      handed: 5,
      firstAnswerSec: 2,
      teamAnswerSec: 30 * 3600,
      ranOut: 2,
    });
  });

  it("calls and wins after the run started, each lead once; money only for those who see it; asked to stop", async () => {
    const f = await flow("Lead magnet");
    const a = await run(f, { at: day(10), lead: true });
    const b2 = await run(f, { at: day(11), lead: true });
    await h.queryAll("UPDATE leads SET won_at = $2, value = 12000 WHERE id = $1", [a.leadId, day(20)]);
    await h.queryAll("UPDATE leads SET won_at = $2, value = 5000 WHERE id = $1", [b2.leadId, day(1)]);
    await h.queryAll("UPDATE leads SET dnc_at = $2, dnc_reason = 'Said stop on Instagram' WHERE id = $1", [
      b2.leadId,
      day(12),
    ]);
    // A stop said on WhatsApp isn't one a flow heard.
    const c = await run(f, { at: day(12) });
    await h.queryAll("UPDATE leads SET dnc_at = $2, dnc_reason = 'Said stop on WhatsApp' WHERE id = $1", [
      c.leadId,
      day(13),
    ]);
    const b = await summary(admin);
    expect(b.total).toMatchObject({ won: 1, revenue: 12000, stopped: 1, wonNew: 1 });
    expect(b.flows[0]).toMatchObject({ won: 1, revenue: 12000 });
    const builder = await h.seedUser({
      grants: [{ key: "instagram.flows.manage", scope: null }],
      totp: false,
    });
    const nb = await summary(builder);
    expect(nb.total.revenue).toBeNull();
    expect(nb.flows[0]!.revenue).toBeNull();
    // Money seen only within one's own reach: these numbers are the whole business's, so no money either.
    const own = await h.seedUser({
      grants: [
        { key: "instagram.flows.manage", scope: null },
        { key: "analytics.view", scope: "own" },
        { key: "analytics.revenue", scope: null },
      ],
      totp: false,
    });
    expect((await summary(own)).total.revenue).toBeNull();
  });

  it("the posts and ads that started them, overall and for each flow", async () => {
    const a = await flow("Ad flow");
    const c = await flow("Comment flow");
    for (let i = 0; i < 3; i++)
      await run(a, { at: day(10 + i), by: "ad", adId: "120200000000001", lead: true });
    for (let i = 0; i < 4; i++)
      await run(c, {
        at: day(10 + i),
        by: "comment",
        media: { id: "17980000000000001", type: "REELS" },
        lead: i < 2,
      });
    const b = await summary(admin);
    expect(b.sources).toEqual([
      { kind: "ad", id: "120200000000001", conversations: 3, leads: 3 },
      { kind: "reels", id: "17980000000000001", conversations: 4, leads: 2 },
    ]);
    expect(b.sourcesByFlow.filter((x) => x.flowId === c.id)).toEqual([
      { flowId: c.id, kind: "reels", id: "17980000000000001", conversations: 4, leads: 2 },
    ]);
  });

  it("a call booked by a lead deleted since isn't counted", async () => {
    const f = await flow("Lead magnet");
    const a = await run(f, { at: day(10), lead: true });
    const c = await h.ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)",
        [admin.id],
      );
      await c.query(
        `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, status, created_at)
         VALUES ($1::uuid, $2, $3, 'calendly', $1::text, 'calendly', 'Call', $4, $4::timestamptz + interval '30 minutes', 'scheduled', $5)`,
        [randomUUID(), a.leadId, admin.id, day(20), day(11)],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect((await summary(admin)).total.booked).toBe(1);
    await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [a.leadId]);
    expect((await summary(admin)).total.booked).toBe(0);
  });

  it("no note that one flow loses the most from a single flow, or when every flow gets everyone to its end", async () => {
    const a = await flow("Only flow");
    for (let i = 0; i < 10; i++) await run(a, { at: day(2 + i), status: i < 3 ? "done" : "stopped" });
    expect((await summary(admin)).notes.map((n) => n.id)).not.toContain("finish");
    const b = await flow("Another");
    await h.queryAll("UPDATE instagram_flow_runs SET status = 'done' WHERE flow_id = $1", [a.id]);
    for (let i = 0; i < 10; i++) await run(b, { at: day(2 + i) });
    expect((await summary(admin)).notes.map((n) => n.id)).not.toContain("finish");
  });

  it("LUME noticed: who waited past 24 hours, the source that brings the most, the flow that loses the most", async () => {
    const a = await flow("Ad flow");
    const c = await flow("Comment flow");
    for (let i = 0; i < 10; i++) {
      await run(a, { at: day(2 + i), by: "ad", adId: "120200000000001", lead: true });
      await run(c, {
        at: day(2 + i),
        by: "comment",
        media: { id: "17980000000000001", type: "REELS" },
        status: i < 3 ? "done" : "stopped",
      });
    }
    await run(a, { at: day(20), status: "handed", handed: HOUR });
    const b = await summary(admin);
    expect(b.notes).toEqual([
      expect.objectContaining({ id: "ran_out", title: "1 passed to your team waited too long" }),
      expect.objectContaining({ id: "best_source", title: "An ad brings the most leads" }),
      expect.objectContaining({
        id: "finish",
        flowId: c.id,
        body: expect.stringMatching(/^30 in every 100/),
      }),
    ]);
  });
});
