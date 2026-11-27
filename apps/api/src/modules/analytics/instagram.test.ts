import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { seedIgAccount } from "../../../test/instagram";

/**
 * Instagram in Analytics (plan 2026-11-25-instagram-screens D6b): conversations by what started them on the business's
 * days; answered in time inside Meta's window (24 hours, 7 days after an ad click); the first answer's median; who
 * answered; what they led to; at the viewer's reach. An empty range says nothing, never 0 seconds or NaN.
 */
let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
let account: { id: string };
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30&compare=0";
const S = 1000;
const HOUR = 3_600 * S;
const DAY = 24 * HOUR;
let n = 0;

type Totals = {
  conversations: number;
  leads: number;
  measured: number;
  inTime: number;
  ranOut: number;
  firstAnswerSec: number | null;
  booked: number;
  won: number;
  revenue: number | null;
  adClicks: number;
  privateReplies: number;
  stopped: number;
  byStart: Record<string, number>;
};
type Board = {
  totals: Totals;
  previous: Totals | null;
  rates: { inTime: number | null; leadRate: number | null };
  series: ({ day: string } & Record<string, number>)[];
  funnel: { id: string; n: number }[];
  whoAnswered: {
    id: string;
    conversations: number;
    booked: number;
    won: number;
    revenue: number | null;
    firstAnswerSec: number | null;
  }[];
  accounts: { username: string | null; status: string; conversations: number; leads: number }[];
  sources: { kind: string; id: string; conversations: number; leads: number; drill: string | null }[];
  drill: Record<
    "conversations" | "leads" | "inTime" | "ranOut" | "booked" | "won" | "stopped" | "flows" | "team",
    string
  > | null;
  notes: { id: string; title: string; body: string }[];
};
const board = async (u: SeededUser, q = Q) => {
  const r = await (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/analytics/instagram?${q}` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Board;
};

/**
 * A conversation started at `at`: what started it, on a lead (owned by `owner`) or not yet, their first message
 * `wrote` ms later, and answers (a flow's or a person's) at these ms after their first message.
 */
async function conv(o: {
  at: Date;
  start?: "comment" | "dm" | "ad" | "story";
  owner?: string | null;
  lead?: boolean;
  wrote?: number;
  flow?: number;
  /** LUME AI's answer, so long after they wrote (plan 2026-11-27-instagram-lume-ai). */
  ai?: number;
  team?: number;
  echo?: number;
  adId?: string;
  media?: { id: string; type: string };
  /** An existing lead (a second conversation of theirs). */
  leadId?: string;
  /** The source as stored, instead of one from `start`. */
  source?: object;
}) {
  const leadId = o.lead === false ? null : (o.leadId ?? (await h.seedLead({ ownerId: o.owner ?? admin.id })));
  const id = randomUUID();
  const source =
    o.start === "comment" || o.start === "story"
      ? { trigger: o.start }
      : o.start === "ad"
        ? { trigger: "ad", ...(o.adId ? { adId: o.adId } : {}) }
        : {};
  await h.queryAll(
    "INSERT INTO instagram_threads (id, account_id, igsid, lead_id, source, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
    [id, account.id, `65120000${++n}`, leadId, JSON.stringify(o.source ?? source), o.at],
  );
  if (o.media)
    await h.queryAll(
      `INSERT INTO instagram_comments (id, account_id, comment_id, media_id, media_type, from_igsid, at, thread_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, '6512', $5, $6)`,
      [account.id, `c${n}`, o.media.id, o.media.type, o.at, id],
    );
  const act = (type: string, at: number, payload: object) =>
    h.queryAll(
      `INSERT INTO activities (id, lead_id, type, occurred_at, payload) VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb)`,
      [leadId, type, new Date(at), JSON.stringify({ threadId: id, ...payload })],
    );
  if (leadId && o.wrote !== undefined) {
    const t0 = o.at.getTime() + o.wrote;
    await act("instagram_received", t0, { text: "Hi" });
    // A later message of theirs: the first is the one timed.
    await act("instagram_received", t0 + 30 * S, { text: "Hello?" });
    if (o.flow !== undefined) await act("instagram_confirmed_sent", t0 + o.flow, { via: "flow" });
    if (o.team !== undefined) await act("instagram_confirmed_sent", t0 + o.team, { via: "lume" });
    if (o.ai !== undefined) await act("instagram_confirmed_sent", t0 + o.ai, { via: "ai" });
    if (o.echo !== undefined) await act("instagram_sent", t0 + o.echo, { via: "echo" });
  }
  return { id, leadId };
}
const day = (d: number, hourUtc = 6) => new Date(Date.UTC(2026, 5, d, hourUtc));
/** A meeting, written as the person whose calendar it's on (its row-level security). */
async function meeting(leadId: string, status: string, startsAt: Date, createdAt: Date) {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      admin.id,
    ]);
    const id = randomUUID();
    await c.query(
      `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at, status, created_at)
       VALUES ($1::uuid, $2, $3, 'calendly', $1::text, 'calendly', 'Call', $4, $4::timestamptz + interval '30 minutes', $5, $6)`,
      [id, leadId, admin.id, startsAt, status, createdAt],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  h = await createHarness();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  h.clock.now = new Date("2026-06-30T12:00:00Z");
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  rep = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "own" },
      { key: "leads.view", scope: "own" },
    ],
  });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.ownerPool.query(
    "TRUNCATE leads, activities, instagram_threads, instagram_comments, meetings CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  account = await seedIgAccount(h, { runAs: admin.id });
});

describe("Instagram in Analytics", () => {
  it("an empty range: nothing, and the timings say so (null), never 0 or NaN", async () => {
    const b = await board(admin);
    expect(b.totals).toMatchObject({
      conversations: 0,
      leads: 0,
      inTime: 0,
      firstAnswerSec: null,
      revenue: 0,
    });
    expect(b.rates).toEqual({ inTime: null, leadRate: null });
    expect(b.series).toHaveLength(30);
    expect(b.series.every((d) => d.comment === 0 && d.dm === 0 && d.ad === 0 && d.story === 0)).toBe(true);
    expect(b.whoAnswered.map((w) => [w.id, w.conversations, w.firstAnswerSec])).toEqual([
      ["flows", 0, null],
      ["team", 0, null],
    ]);
    expect(b.accounts).toMatchObject([{ conversations: 0, leads: 0, status: "active" }]);
  });

  it("each conversation by what started it, on the business's own day (east of UTC)", async () => {
    // 19:00 UTC on June 2 is half past midnight on June 3 in India.
    await conv({ at: day(2, 19), start: "comment" });
    await conv({ at: day(3), start: "dm" });
    await conv({ at: day(3), start: "story" });
    await conv({ at: day(5), start: "ad", adId: "120200000000001" });
    // Not yet a lead: a conversation all the same, for someone who sees everything.
    await conv({ at: day(5), start: "dm", lead: false });
    // Before the range (May 31 in India) and after it: not counted.
    await conv({ at: new Date("2026-05-31T18:00:00Z") });
    await conv({ at: new Date("2026-06-30T18:31:00Z") });
    const b = await board(admin);
    expect(b.totals.conversations).toBe(5);
    expect(b.totals.leads).toBe(4);
    expect(b.totals.byStart).toEqual({ comment: 1, dm: 2, ad: 1, story: 1 });
    expect(b.series.find((d) => d.day === "2026-06-02")).toMatchObject({ comment: 0 });
    expect(b.series.find((d) => d.day === "2026-06-03")).toMatchObject({ comment: 1, dm: 1, story: 1 });
    expect(b.series.find((d) => d.day === "2026-06-05")).toMatchObject({ dm: 1, ad: 1 });
    expect(b.rates.leadRate).toBeCloseTo(0.8);
  });

  it("a deleted lead's conversation still started, but isn't a lead", async () => {
    const c = await conv({ at: day(10), wrote: 0, team: HOUR });
    await h.queryAll("UPDATE leads SET deleted_at = $2 WHERE id = $1", [c.leadId, day(20)]);
    expect((await board(admin)).totals).toMatchObject({ conversations: 1, leads: 0, inTime: 0 });
  });

  it("the day boundary west of UTC too", async () => {
    await h.ownerPool.query("UPDATE settings SET timezone = 'America/New_York' WHERE id = 1");
    try {
      // 02:00 UTC on June 10 is 22:00 on June 9 in New York.
      await conv({ at: day(10, 2), start: "dm" });
      const b = await board(admin);
      expect(b.series.find((d) => d.day === "2026-06-09")).toMatchObject({ dm: 1 });
      expect(b.series.find((d) => d.day === "2026-06-10")).toMatchObject({ dm: 0 });
    } finally {
      await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
    }
  });

  it("answered in time inside Meta's window; the first answer's median; ran out; still open is neither", async () => {
    await conv({ at: day(10), wrote: 0, flow: 3 * S }); // a flow, in 3 seconds
    await conv({ at: day(11), wrote: 60 * S, team: 2 * HOUR }); // a person from LUME, in 2 hours
    await conv({ at: day(12), wrote: 0, echo: 25 * HOUR }); // from the Instagram app, after the 24 hours
    await conv({ at: day(13), start: "ad", wrote: 0, team: 3 * DAY }); // an ad click: 7 days
    await conv({ at: day(14), wrote: 0 }); // never answered: the 24 hours ran out
    await conv({ at: new Date(h.clock.now.getTime() - 2 * HOUR), wrote: 0 }); // unanswered, still open
    await conv({ at: day(15), start: "comment" }); // a comment, they never wrote: not timed
    const b = await board(admin);
    expect(b.totals).toMatchObject({ conversations: 7, measured: 5, inTime: 3, ranOut: 2, adClicks: 1 });
    expect(b.rates.inTime).toBeCloseTo(3 / 5);
    // 3 s, 2 h, 25 h, 3 days: the median is between 2 h and 25 h.
    expect(b.totals.firstAnswerSec).toBe(Math.round((2 * 3600 + 25 * 3600) / 2));
    expect(b.funnel.map((f) => [f.id, f.n])).toEqual([
      ["wrote", 7],
      ["lead", 7],
      ["booked", 0],
      ["won", 0],
    ]);
  });

  it("the answer after their first message: one sent before they wrote doesn't count", async () => {
    const c = await conv({ at: day(10), wrote: HOUR });
    await h.queryAll(
      `INSERT INTO activities (id, lead_id, type, occurred_at, payload) VALUES (gen_random_uuid(), $1, 'instagram_confirmed_sent', $2, $3::jsonb)`,
      [c.leadId, new Date(day(10).getTime() + 60 * S), JSON.stringify({ via: "flow", threadId: c.id })],
    );
    const b = await board(admin);
    expect(b.totals).toMatchObject({ inTime: 0, ranOut: 1, firstAnswerSec: null });
  });

  it("another conversation's messages on the same lead aren't this one's", async () => {
    const a = await conv({ at: day(10), wrote: 0 });
    // The same lead on another account answered within a minute: not an answer here.
    const other = randomUUID();
    await h.queryAll(
      `INSERT INTO activities (id, lead_id, type, occurred_at, payload) VALUES (gen_random_uuid(), $1, 'instagram_confirmed_sent', $2, $3::jsonb)`,
      [a.leadId, new Date(day(10).getTime() + 60 * S), JSON.stringify({ via: "lume", threadId: other })],
    );
    const b = await board(admin);
    expect(b.totals.inTime).toBe(0);
    const r = await (
      await h.signIn(admin)
    ).inject({
      method: "GET",
      url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(b.drill!.inTime)}`,
    });
    expect((r.json() as { total: number }).total).toBe(0);
  });

  it("who answered: a conversation counts for each that answered it, with their own first answer", async () => {
    await conv({ at: day(10), wrote: 0, flow: 2 * S, team: HOUR });
    await conv({ at: day(11), wrote: 0, flow: 4 * S });
    await conv({ at: day(12), wrote: 0, echo: 30 * 60 * S });
    const b = await board(admin);
    expect(b.whoAnswered).toMatchObject([
      { id: "flows", conversations: 2, firstAnswerSec: 3 },
      { id: "team", conversations: 2, firstAnswerSec: Math.round((3600 + 1800) / 2) },
    ]);
  });

  it("who answered: LUME AI's row once it answered, never counted as the team's; its leads open from it", async () => {
    await conv({ at: day(10), wrote: 0, ai: 20 * S });
    await conv({ at: day(11), wrote: 0, team: HOUR });
    const b = await board(admin);
    expect(b.whoAnswered.map((w) => [w.id, w.conversations, w.firstAnswerSec])).toEqual([
      ["flows", 0, null],
      ["ai", 1, 20],
      ["team", 1, 3600],
    ]);
    expect(b.totals.inTime).toBe(2);
    const r = await (
      await h.signIn(admin)
    ).inject({
      method: "GET",
      url: `/api/v1/analytics/drilldown?token=${encodeURIComponent((b.drill as unknown as { ai: string }).ai)}`,
    });
    expect((r.json() as { total: number }).total).toBe(1);
  });

  it("what they led to: a call booked and a win after the conversation started; money only for those who see it", async () => {
    const a = await conv({ at: day(10), wrote: 0, flow: S });
    const b2 = await conv({ at: day(11), wrote: 0, team: HOUR });
    await conv({ at: day(12) });
    await meeting(a.leadId!, "scheduled", day(20), day(10, 9));
    // A cancelled meeting, and one made before the conversation started: neither is a call it led to.
    await meeting(b2.leadId!, "cancelled", day(21), day(11, 9));
    await meeting(b2.leadId!, "scheduled", day(21), day(11, 5));
    await h.queryAll("UPDATE leads SET won_at = $2, value = 12000 WHERE id = $1", [a.leadId, day(25)]);
    await h.queryAll("UPDATE leads SET won_at = $2, value = 5000 WHERE id = $1", [b2.leadId, day(1)]);
    const b = await board(admin);
    expect(b.totals).toMatchObject({ booked: 1, won: 1, revenue: 12000 });
    expect(b.whoAnswered[0]).toMatchObject({ id: "flows", booked: 1, won: 1, revenue: 12000 });
    expect(b.whoAnswered[1]).toMatchObject({ id: "team", booked: 0, won: 0 });
    const noMoney = await h.seedUser({
      grants: [
        { key: "analytics.view", scope: "all" },
        { key: "leads.view", scope: "all" },
      ],
    });
    const nb = await board(noMoney);
    expect(nb.totals.revenue).toBeNull();
    expect(nb.whoAnswered[0]!.revenue).toBeNull();
  });

  it("someone who sees only their own leads: their conversations, never one not yet a lead", async () => {
    await conv({ at: day(10), owner: rep.id, wrote: 0, team: HOUR });
    await conv({ at: day(10), wrote: 0 });
    await conv({ at: day(10), lead: false });
    const b = await board(rep);
    expect(b.totals).toMatchObject({ conversations: 1, leads: 1, inTime: 1 });
    expect((await board(admin)).totals).toMatchObject({ conversations: 3, leads: 2 });
  });

  it("private replies that went, and those who asked on Instagram to stop, by when it happened", async () => {
    const c = await conv({
      at: day(10),
      start: "comment",
      media: { id: "17980000000000001", type: "REELS" },
    });
    await h.queryAll(
      "UPDATE instagram_comments SET private_reply = 'sent', private_reply_at = $2 WHERE thread_id = $1",
      [c.id, day(10, 7)],
    );
    const failed = await conv({
      at: day(11),
      start: "comment",
      media: { id: "17980000000000002", type: "IMAGE" },
    });
    await h.queryAll(
      "UPDATE instagram_comments SET private_reply = 'failed', private_reply_at = $2 WHERE thread_id = $1",
      [failed.id, day(11, 7)],
    );
    await h.queryAll("UPDATE leads SET dnc_at = $2, dnc_reason = 'Said stop on Instagram' WHERE id = $1", [
      c.leadId,
      day(12),
    ]);
    await h.queryAll("UPDATE leads SET dnc_at = $2, dnc_reason = 'Said stop on WhatsApp' WHERE id = $1", [
      failed.leadId,
      day(12),
    ]);
    const b = await board(admin);
    expect(b.totals).toMatchObject({ privateReplies: 1, stopped: 1 });
  });

  it("the posts and ads that started the most, by leads; each account with its own", async () => {
    for (let i = 0; i < 3; i++) await conv({ at: day(10 + i), start: "ad", adId: "120200000000001" });
    for (let i = 0; i < 2; i++)
      await conv({ at: day(10 + i), start: "comment", media: { id: "17980000000000001", type: "REELS" } });
    await conv({
      at: day(12),
      start: "comment",
      media: { id: "17980000000000001", type: "REELS" },
      lead: false,
    });
    await conv({
      at: day(13),
      start: "comment",
      media: { id: "17980000000000001", type: "REELS" },
      lead: false,
    });
    await conv({ at: day(13), start: "dm" });
    const b = await board(admin);
    // The reel started more conversations; the ad brought more leads, and leads come first.
    expect(b.sources).toMatchObject([
      { kind: "ad", id: "120200000000001", conversations: 3, leads: 3 },
      { kind: "reels", id: "17980000000000001", conversations: 4, leads: 2 },
    ]);
    expect(b.accounts).toMatchObject([{ conversations: 8, leads: 6 }]);
  });

  it("Analytics shows the board while the business has an Instagram account, to anyone who sees analytics", async () => {
    const there = async (u: SeededUser) =>
      (
        await (await h.signIn(u)).inject({ method: "GET", url: "/api/v1/analytics/instagram/there" })
      ).json() as {
        there: boolean;
      };
    expect(await there(rep)).toEqual({ there: true });
    await h.ownerPool.query("DELETE FROM instagram_accounts");
    expect(await there(admin)).toEqual({ there: false });
  });

  it("someone who can open fewer leads than their analytics reach: refused in words, never part shown as the whole", async () => {
    const manager = await h.seedUser({
      grants: [
        { key: "analytics.view", scope: "all" },
        { key: "leads.view", scope: "own" },
      ],
    });
    const r = await (
      await h.signIn(manager)
    ).inject({ method: "GET", url: `/api/v1/analytics/instagram?${Q}` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/^Instagram's numbers are counted from the leads you can open/);
  });

  it("a lead filter: only conversations on such leads, never one not yet a lead", async () => {
    await conv({ at: day(10), wrote: 0 });
    await conv({ at: day(10), lead: false });
    const cfg = await h.config();
    const b = await board(admin, `${Q}&pipeline=${cfg.pipelineId}`);
    expect(b.totals).toMatchObject({ conversations: 1, leads: 1 });
    // Leads nobody owns: a conversation with no lead isn't one of those either.
    expect((await board(admin, `${Q}&owner=none`)).totals.conversations).toBe(0);
  });

  it("a lead on two conversations: two conversations, one lead, one win and its money once", async () => {
    const a = await conv({ at: day(10), wrote: 0, flow: S });
    await conv({ at: day(12), leadId: a.leadId!, wrote: 0, flow: S });
    await h.queryAll("UPDATE leads SET won_at = $2, value = 12000 WHERE id = $1", [a.leadId, day(25)]);
    const b = await board(admin);
    expect(b.totals).toMatchObject({ conversations: 2, leads: 1, won: 1, revenue: 12000 });
    expect(b.funnel.map((f) => f.n)).toEqual([2, 1, 0, 1]);
    expect(b.whoAnswered[0]).toMatchObject({ id: "flows", conversations: 2, won: 1, revenue: 12000 });
  });

  it("a conversation matched to a lead LUME already had: a conversation, not a new lead", async () => {
    const c = await conv({ at: day(10), wrote: 0, team: HOUR });
    await h.queryAll("UPDATE leads SET created_at = $2, won_at = $3 WHERE id = $1", [
      c.leadId,
      day(1),
      day(20),
    ]);
    const b = await board(admin);
    // Won after the conversation, so counted as won; not a lead it made, so not in its funnel.
    expect(b.totals).toMatchObject({ conversations: 1, leads: 0, inTime: 1, won: 1 });
    expect(b.funnel.map((f) => f.n)).toEqual([1, 0, 0, 0]);
  });

  it("what started it is kept when an ad click comes later: a DM's, with a DM's 24 hours", async () => {
    await conv({
      at: day(10),
      source: { start: "dm", trigger: "ad", adId: "120200000000009" },
      wrote: 0,
      team: 2 * DAY,
    });
    const b = await board(admin);
    expect(b.totals.byStart).toEqual({ comment: 0, dm: 1, ad: 0, story: 0 });
    expect(b.totals).toMatchObject({ inTime: 0, ranOut: 1 });
  });

  it("with a tag filter, at most 92 days", async () => {
    const r = await (
      await h.signIn(admin)
    ).inject({
      method: "GET",
      url: `/api/v1/analytics/instagram?range=custom&from=2026-01-01&to=2026-06-30&tag=${randomUUID()}`,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("RANGE_TOO_LONG_FOR_FILTER");
  });

  it("every number opens exactly the leads behind it (D6b-2)", async () => {
    const a = await conv({ at: day(10), wrote: 0, flow: 3 * S }); // in time, by a flow
    await conv({ at: day(11), wrote: 0, team: 2 * HOUR }); // in time, by a person
    await conv({ at: day(12), wrote: 0, echo: 25 * HOUR }); // ran out (answered late, from the app)
    await conv({ at: day(13), wrote: 0 }); // ran out, never answered
    await conv({ at: day(14), start: "ad", adId: "120200000000001", wrote: 0, team: 3 * DAY }); // ad: 7 days
    await conv({ at: day(15), lead: false }); // not a lead: counted, nobody to open
    const old = await conv({ at: day(16), wrote: 0, team: HOUR }); // matched to an older lead
    await h.queryAll("UPDATE leads SET created_at = $2 WHERE id = $1", [old.leadId, day(1)]);
    await meeting(a.leadId!, "scheduled", day(20), day(10, 9));
    await h.queryAll("UPDATE leads SET won_at = $2, value = 9000 WHERE id = $1", [a.leadId, day(22)]);
    await h.queryAll("UPDATE leads SET dnc_at = $2, dnc_reason = 'Said stop on Instagram' WHERE id = $1", [
      old.leadId,
      day(17),
    ]);
    // Not these numbers': a conversation before the range, one still inside its 24 hours, a stop said on WhatsApp.
    await conv({ at: new Date("2026-05-20T06:00:00Z"), wrote: 0 });
    await conv({ at: new Date(h.clock.now.getTime() - 2 * HOUR), wrote: 0 });
    // The same ad started one more, matched to a lead LUME already had: the ad's row counts new leads only.
    const matched = await conv({ at: day(18), start: "ad", adId: "120200000000001" });
    await h.queryAll("UPDATE leads SET created_at = $2 WHERE id = $1", [matched.leadId, day(1)]);
    const wa = await h.seedLead({ ownerId: admin.id });
    await h.queryAll("UPDATE leads SET dnc_at = $2, dnc_reason = 'Said stop on WhatsApp' WHERE id = $1", [
      wa,
      day(17),
    ]);
    const b = await board(admin);
    const open = async (token: string) => {
      const r = await (
        await h.signIn(admin)
      ).inject({
        method: "GET",
        url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(token)}`,
      });
      expect(r.statusCode, r.body).toBe(200);
      return (r.json() as { total: number }).total;
    };
    const d = b.drill!;
    expect(b.totals).toMatchObject({
      conversations: 9,
      leads: 6,
      inTime: 4,
      ranOut: 2,
      booked: 1,
      won: 1,
      stopped: 1,
    });
    // The conversation not yet a lead is the one the list can't hold.
    expect(await open(d.conversations)).toBe(8);
    expect(await open(d.leads)).toBe(b.totals.leads);
    expect(await open(d.inTime)).toBe(b.totals.inTime);
    expect(await open(d.ranOut)).toBe(b.totals.ranOut);
    expect(await open(d.booked)).toBe(b.totals.booked);
    expect(await open(d.won)).toBe(b.totals.won);
    expect(await open(d.stopped)).toBe(b.totals.stopped);
    expect(await open(d.flows)).toBe(b.whoAnswered[0]!.conversations);
    expect(await open(d.team)).toBe(b.whoAnswered[1]!.conversations);
    expect(b.sources).toHaveLength(1);
    expect(await open(b.sources[0]!.drill!)).toBe(b.sources[0]!.leads);
    // Someone else's list: as if it didn't exist.
    const r = await (
      await h.signIn(rep)
    ).inject({
      method: "GET",
      url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(d.leads)}`,
    });
    expect(r.statusCode).toBe(404);
    // Filtered to someone's leads: only theirs open.
    const theirs = await board(admin, `${Q}&owner=${rep.id}`);
    expect(await open(theirs.drill!.leads)).toBe(0);
  });

  it("someone whose analytics reach is their own: their numbers, and lists of only their leads", async () => {
    const mine = await h.seedUser({
      grants: [
        { key: "analytics.view", scope: "own" },
        { key: "leads.view", scope: "all" },
      ],
    });
    await conv({ at: day(10), owner: mine.id, wrote: 0, team: HOUR });
    await conv({ at: day(11), wrote: 0, team: HOUR });
    const b = await board(mine);
    expect(b.totals).toMatchObject({ conversations: 1, leads: 1 });
    const r = await (
      await h.signIn(mine)
    ).inject({
      method: "GET",
      url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(b.drill!.leads)}`,
    });
    expect((r.json() as { total: number }).total).toBe(1);
  });

  it("LUME noticed: what ran out, the source that brings the most, who answers faster; none from too few", async () => {
    expect((await board(admin)).notes).toEqual([]);
    for (let i = 0; i < 10; i++) {
      await conv({ at: day(2 + i), start: "ad", adId: "120200000000001", wrote: 0, flow: 4 * S });
      await conv({
        at: day(2 + i),
        start: "comment",
        media: { id: "17980000000000001", type: "REELS" },
        wrote: 0,
        team: 20 * 60 * S,
      });
    }
    // The reel started five more that aren't leads: fewer leads in every 100 than the ad.
    for (let i = 0; i < 5; i++)
      await conv({
        at: day(2 + i),
        start: "comment",
        media: { id: "17980000000000001", type: "REELS" },
        lead: false,
      });
    // One more from the ad that isn't a lead.
    await conv({ at: day(12), start: "ad", adId: "120200000000001", lead: false });
    // A post with two conversations, both leads: too few to say it brings the most.
    for (let i = 0; i < 2; i++)
      await conv({ at: day(3 + i), start: "comment", media: { id: "17980000000000009", type: "IMAGE" } });
    await conv({ at: day(20), wrote: 0 });
    const b = await board(admin);
    expect(b.notes).toEqual([
      expect.objectContaining({ id: "ran_out", title: "1 ran out of time" }),
      expect.objectContaining({
        id: "best_source",
        title: "An ad brings the most leads",
        body: "10 leads from 11 conversations it started: 91 in every 100.",
      }),
      expect.objectContaining({ id: "speed", title: "Flows answer in 4 seconds, your team in 20 minutes" }),
    ]);
  });

  it("too few to say: no note on a source or on who answers faster", async () => {
    // Flows answered ten, the team nine: too few of the team's to compare.
    for (let i = 0; i < 10; i++) await conv({ at: day(2 + i), wrote: 0, flow: 4 * S });
    for (let i = 0; i < 9; i++) await conv({ at: day(2 + i), wrote: 0, team: 20 * 60 * S });
    // A source with nine conversations: too few to say it brings the most.
    for (let i = 0; i < 9; i++) await conv({ at: day(2 + i), start: "ad", adId: "120200000000001" });
    expect((await board(admin)).notes).toEqual([]);
  });

  it("compared with the days before", async () => {
    await conv({ at: day(10), start: "dm" });
    await conv({ at: new Date("2026-05-10T06:00:00Z"), start: "dm" });
    await conv({ at: new Date("2026-05-11T06:00:00Z"), start: "dm" });
    const b = await board(admin, "range=custom&from=2026-06-01&to=2026-06-30&compare=1");
    expect(b.totals.conversations).toBe(1);
    expect(b.previous!.conversations).toBe(2);
  });
});
