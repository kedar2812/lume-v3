import { generateKeyPairSync } from "node:crypto";
import {
  ALL_GRANTS,
  nextStepOutput,
  rawPublicKey,
  signLicence,
  type AiTask,
  type LicencePayload,
  type PlanClaim,
} from "@lume/core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { fakeProvider } from "../../ai/fake";
import { AiUnreadable, type AiProvider } from "../../ai/provider";
import type { AppDeps } from "../../app";
import { runRead } from "./service";

/** LUME AI's switch, its Claude-style limits and its notices (spec 2026-10-18 §2.2). */
const server = generateKeyPairSync("ed25519");
const D = 86_400_000;
const all = {
  googleSheets: true,
  webhooks: true,
  googleCalendar: true,
  calendly: true,
  ai: true,
  whatsapp: true,
};
let h: Harness;
let ownerUser: { id: string; email: string; password: string };
let repUser: { id: string; email: string; password: string };
let lead: string;
let plan: PlanClaim | undefined;
let provider: AiProvider = fakeProvider();
let topUpCalls: { month: string; askedBy: { name: string; email: string } }[] = [];
/** The app's own deps: a test sets the owner's prices on them (2026-11-12). */
let deps: AppDeps;

const token = () =>
  signLicence(
    {
      v: 1,
      kid: "t1",
      instanceId: "LUME-TEST-AI",
      state: "active",
      licenseType: "subscription",
      issuedAt: h.clock.now.toISOString(),
      validUntil: new Date(h.clock.now.getTime() + 8 * D).toISOString(),
      paidUntil: "2027-12-31",
      trialEndsAt: null,
      reason: "paid",
      notice: null,
      ...(plan ? { plan } : {}),
    } satisfies LicencePayload,
    server.privateKey,
  );
// Signed in afresh for each request: the tests move the clock by days, past a session's life.
const owner = () => h.signIn(ownerUser);
const rep = () => h.signIn(repUser);
const withPlan = async (p: PlanClaim | undefined) => {
  plan = p;
  await (await owner()).inject({ method: "POST", url: "/api/v1/licence/check" });
};
const limits = (aiReadsHourly: number | null, aiReadsWeekly: number | null) =>
  withPlan({ places: null, modules: all, aiReadsHourly, aiReadsWeekly });
const read = async (as: () => Promise<AuthedClient> = rep) =>
  (await as()).inject({ method: "POST", url: `/test/ai-read/${lead}` });
/** Reads and notices are row-level secured: the backup role sees them all, as other tests read them. */
const asBackup = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const reader = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
  await reader.connect();
  return fn(reader).finally(() => reader.end());
};
const okReads = () =>
  asBackup(async (c) =>
    Number((await c.query("SELECT count(*) FROM ai_reads WHERE status = 'ok'")).rows[0].count),
  );
let noticesFrom = 0;
const alerts = (like: string) =>
  asBackup(
    async (c) =>
      (
        await c.query<{ user_id: string; title: string; body: string }>(
          "SELECT user_id, title, body FROM notifications WHERE kind = 'system_alert' AND title LIKE $1 AND id > $2 ORDER BY id",
          [like, noticesFrom],
        )
      ).rows,
  );

beforeAll(async () => {
  h = await createHarness({
    licence: {
      mode: "enforce",
      instanceId: "LUME-TEST-AI",
      licenseKey: "LUME-KEY-SECRET-AI",
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.7.0",
      fetch: (async (url: string | URL, init?: RequestInit) => {
        // Autopilot A1: a top-up request goes to the licence server; one open request a month.
        if (String(url).endsWith("/v1/topup")) {
          topUpCalls.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify(topUpCalls.length > 1 ? { asked: true, already: true } : { asked: true }),
            {
              status: topUpCalls.length > 1 ? 200 : 201,
            },
          );
        }
        return new Response(JSON.stringify({ token: token() }), { status: 200 });
      }) as typeof fetch,
    },
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
    aiTimeoutMs: 200,
    extraRoutes: (app, d) => {
      deps = d;
      app.post<{ Params: { id: string }; Querystring: { task?: AiTask } }>(
        "/test/ai-read/:id",
        { config: { permission: "leads.view" } },
        (req) =>
          runRead(req, d, {
            // Any task (AI leads, 2026-11-12: which ones count); the fake answers by the schema.
            task: req.query.task ?? "next_step",
            leadId: req.params.id,
            instructions: "Rules.",
            input: "{}",
            schema: nextStepOutput,
            maxOutputTokens: 500,
          }),
      );
    },
  });
  await h.ownerPool.query("UPDATE settings SET timezone = 'Asia/Kolkata' WHERE id = 1");
  ownerUser = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  repUser = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
  lead = await h.seedLead({ ownerId: repUser.id, name: "Sneha Reddy" });
});
afterAll(() => h.close());
beforeEach(async () => {
  provider = fakeProvider();
  topUpCalls = [];
  deps.aiPricing = null;
  deps.aiModels = {};
  // No read is ever deleted (no delete policy, by design): the owner empties the table between tests.
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices, ai_lead_months");
  noticesFrom = await asBackup(async (r) =>
    Number((await r.query("SELECT coalesce(max(id), 0) AS n FROM notifications")).rows[0].n),
  );
  await h.ownerPool.query(`UPDATE settings SET integrations = integrations - 'ai' WHERE id = 1`);
  h.clock.now = new Date("2026-10-21T10:00:00Z"); // Wednesday 3:30 pm in Kolkata
  await withPlan({ places: null, modules: all, aiReadsHourly: null, aiReadsWeekly: null });
});
const switchOn = async () =>
  (await owner()).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });

describe("the switch", () => {
  it("off by default: no read, nothing written, and the screen says it's off", async () => {
    expect((await read()).json()).toEqual({ unavailable: "off" });
    expect(await okReads()).toBe(0);
    expect((await (await rep()).inject({ method: "GET", url: "/api/v1/ai" })).json()).toMatchObject({
      on: false,
    });
  });

  it("an admin switches it on, with an audit row; a rep can't", async () => {
    expect(
      (
        await (
          await rep()
        ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } })
      ).statusCode,
    ).toBe(403);
    const r = await switchOn();
    expect(r.statusCode).toBe(200);
    expect(r.json().ai).toEqual({ enabled: true, available: true, inPlan: true });
    const audit = await h.ownerPool.query(
      "SELECT diff FROM audit_log WHERE action = 'integration.enabled' AND diff ->> 'module' = 'ai'",
    );
    expect(audit.rows).toHaveLength(1);
    expect((await read()).json()).toMatchObject({ output: { summary: expect.any(String) } });
  });

  it("refuses to switch on when the plan leaves it out", async () => {
    await withPlan({ places: null, modules: { ...all, ai: false } });
    const r = await switchOn();
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("PLAN_MODULE");
  });
});

describe("the limits", () => {
  beforeEach(async () => {
    await switchOn();
  });

  it("the hourly limit rolls: at 2 an hour the third read waits until the first is an hour old", async () => {
    await limits(2, null);
    expect((await read()).json()).toHaveProperty("output");
    h.clock.advance(10 * 60_000);
    expect((await read()).json()).toHaveProperty("output");
    expect((await read()).json()).toEqual({
      unavailable: "limit",
      by: "hour",
      until: "2026-10-21T11:00:00.000Z",
    });
    h.clock.now = new Date("2026-10-21T11:00:01Z");
    expect((await read()).json()).toHaveProperty("output");
  });

  it("the weekly limit resets Monday 00:00 on the business's clock", async () => {
    await limits(null, 1);
    h.clock.now = new Date("2026-10-25T18:00:00Z"); // Sunday 11:30 pm in Kolkata
    expect((await read()).json()).toHaveProperty("output");
    h.clock.now = new Date("2026-10-25T18:29:00Z"); // Sunday 11:59 pm
    expect((await read()).json()).toMatchObject({ unavailable: "limit", by: "week" });
    h.clock.now = new Date("2026-10-25T18:30:00Z"); // Monday 00:00
    expect((await read()).json()).toHaveProperty("output");
  });

  it("failed reads aren't counted", async () => {
    await limits(1, null);
    provider = {
      name: "fake",
      model: "fake-1",
      read: async () => {
        throw new Error("provider down");
      },
    };
    expect((await read()).json()).toEqual({ unavailable: "failed" });
    provider = fakeProvider();
    expect((await read()).json()).toHaveProperty("output");
  });

  it("two reads at the last slot: only one passes", async () => {
    await limits(1, null);
    const [a, b] = await Promise.all([read(), read(owner)]);
    expect([a.json(), b.json()].filter((x) => "output" in x)).toHaveLength(1);
  });

  it("a provider that hangs fails after the timeout and isn't counted", async () => {
    provider = {
      name: "fake",
      model: "fake-1",
      read: (o) =>
        new Promise((_, reject) => o.signal.addEventListener("abort", () => reject(o.signal.reason))),
    };
    expect((await read()).json()).toEqual({ unavailable: "failed" });
    expect(await okReads()).toBe(0);
  });

  it("tells admins once at 75%, once at 90%, and once at the limit — never the rep, never twice", async () => {
    await limits(null, 10);
    for (let i = 0; i < 10; i++) await read();
    await read(); // refused: the limit
    await read(); // refused again: no second notice
    const notes = await alerts("LUME AI%");
    const titles = [...new Set(notes.map((n) => n.title))];
    expect(titles).toEqual([
      "LUME AI has used 75% of this week's reads",
      "LUME AI has used 90% of this week's reads",
      "LUME AI has reached this week's limit",
    ]);
    expect(notes.find((n) => n.title.includes("reached"))!.body).toBe("It's back Monday.");
    expect(notes.find((n) => n.title.includes("75%"))!.body).toBe(
      "8 of 10 used this week. It starts again Monday.",
    );
    expect(new Set(notes.map((n) => n.user_id)).size * 3).toBe(notes.length);
  });

  it("GET /ai says this hour's and this week's use and when each resets", async () => {
    await limits(100, 750);
    await read();
    expect((await (await rep()).inject({ method: "GET", url: "/api/v1/ai" })).json()).toEqual({
      on: true,
      hour: { used: 1, limit: 100, resetsAt: "2026-10-21T11:00:00.000Z" },
      week: { used: 1, limit: 750, resetsAt: "2026-10-25T18:30:00.000Z" },
      // A licence without the month (plan3 or older): no monthly limit, no spend set, no top-ups to ask for (a rep).
      month: { used: 1, limit: null, resetsAt: "2026-10-31T18:30:00.000Z" },
      // The read was a next step: its lead is counted this month (AI leads), against no limit on this licence.
      leads: { used: 1, limit: null, resetsAt: "2026-10-31T18:30:00.000Z" },
      countsLeads: false,
      paused: null,
      spend: null,
      pace: { daysLeft: null },
      topUp: null,
    });
  });
});

/** Autopilot A1 Task 3 (spec 2026-10-19 §4): one monthly allowance, its notices, spend, and asking for a top-up. */
describe("the month", () => {
  const monthly = (aiCallsMonthly: number | null, aiTopUps: { month: string; calls: number }[] = []) =>
    withPlan({ places: null, modules: all, aiReadsHourly: null, aiReadsWeekly: 3, aiCallsMonthly, aiTopUps });
  beforeEach(async () => {
    await switchOn();
  });

  it("with a monthly plan, reads count against the month and the week is ignored", async () => {
    await monthly(5);
    for (let i = 0; i < 5; i++) expect((await read()).json()).toHaveProperty("output");
    expect((await read()).json()).toEqual({
      unavailable: "limit",
      by: "month",
      until: "2026-10-31T18:30:00.000Z", // November 1, 00:00 in Kolkata
    });
  });

  it("admins hear once at 75% and 90% of the month, and once at the limit", async () => {
    await monthly(10);
    for (let i = 0; i < 10; i++) await read();
    await read();
    await read();
    const notes = await alerts("LUME AI%");
    expect([...new Set(notes.map((n) => n.title))]).toEqual([
      "LUME AI has used 75% of this month's allowance",
      "LUME AI has used 90% of this month's allowance",
      "LUME AI has reached this month's allowance",
    ]);
    expect(notes.find((n) => n.title.includes("75%"))!.body).toBe(
      "8 of 10 used this month. It starts again on November 1.",
    );
    expect(notes.find((n) => n.title.includes("reached"))!.body).toBe(
      "It's back on November 1, or sooner with a top-up: ask for one from LUME AI's ring.",
    );
  });

  it("after a top-up, admins hear again at 75%, 90% and the limit of the new allowance, once each", async () => {
    await monthly(4);
    for (let i = 0; i < 5; i++) await read(); // 3 → 75%, 4 → 90%, the 5th is refused → limit
    await monthly(4, [{ month: "2026-10", calls: 4 }]); // 8 now: 6 is 75%, 8 is 90%, the 9th the limit
    for (let i = 0; i < 6; i++) await read();
    const titles = (await alerts("LUME AI%")).map((n) => n.title);
    const times = (t: string) => titles.filter((x) => x === t).length;
    expect(times("LUME AI has used 75% of this month's allowance")).toBe(2);
    expect(times("LUME AI has used 90% of this month's allowance")).toBe(2);
    expect(times("LUME AI has reached this month's allowance")).toBe(2);
  });

  it("a top-up ends the pause", async () => {
    await monthly(1);
    expect((await read()).json()).toHaveProperty("output");
    expect((await read()).json()).toMatchObject({ unavailable: "limit", by: "month" });
    await monthly(1, [{ month: "2026-10", calls: 1 }]);
    expect((await read()).json()).toHaveProperty("output");
  });

  it("GET /ai says the month's use, the pace, and for an admin whether a top-up's been asked", async () => {
    await monthly(3000);
    await read();
    const forRep = (await (await rep()).inject({ method: "GET", url: "/api/v1/ai" })).json();
    expect(forRep).toMatchObject({
      on: true,
      month: { used: 1, limit: 3000, resetsAt: "2026-10-31T18:30:00.000Z" },
      spend: null,
      topUp: null,
    });
    expect(forRep.pace.daysLeft).toBeGreaterThan(30);
    const forAdmin = (await (await owner()).inject({ method: "GET", url: "/api/v1/ai" })).json();
    expect(forAdmin.topUp).toEqual({ asked: false });
  });

  it("one request a month: the second press says already; only an admin may ask", async () => {
    await monthly(1);
    expect(
      (await (await rep()).inject({ method: "POST", url: "/api/v1/ai/topup", payload: {} })).statusCode,
    ).toBe(403);
    const first = await (await owner()).inject({ method: "POST", url: "/api/v1/ai/topup", payload: {} });
    expect(first.json()).toEqual({ asked: true });
    expect(topUpCalls[0]).toMatchObject({ month: "2026-10" });
    const again = await (await owner()).inject({ method: "POST", url: "/api/v1/ai/topup", payload: {} });
    expect(again.json()).toEqual({ asked: true, already: true });
    expect((await (await owner()).inject({ method: "GET", url: "/api/v1/ai" })).json().topUp).toEqual({
      asked: true,
    });
    // Pressed again while it stands: LUME answers itself, nothing more goes to the owner.
    expect(topUpCalls).toHaveLength(1);
  });

  it("once the top-up arrives it's no longer asked: a busy month can ask again", async () => {
    await monthly(1);
    await (await owner()).inject({ method: "POST", url: "/api/v1/ai/topup", payload: {} });
    const status = async () =>
      (await (await owner()).inject({ method: "GET", url: "/api/v1/ai" })).json().topUp;
    expect(await status()).toEqual({ asked: true });
    await monthly(1, [{ month: "2026-10", calls: 1 }]);
    expect(await status()).toEqual({ asked: false });
    const second = await (await owner()).inject({ method: "POST", url: "/api/v1/ai/topup", payload: {} });
    expect(second.statusCode).toBe(200);
    expect(topUpCalls).toHaveLength(2);
    expect(await status()).toEqual({ asked: true });
  });
});

/** What a read cost (2026-11-12): a provider bills an answer LUME couldn't use, so its tokens are kept and priced. */
describe("what a read cost", () => {
  const billed = { inputTokens: 1_000_000, outputTokens: 100_000, cacheWriteTokens: 0, cacheReadTokens: 0 };
  const unusable = (): AiProvider => ({
    name: "fake",
    model: "fake-1",
    read: async () => {
      throw new AiUnreadable("not JSON", billed);
    },
  });
  const rows = () =>
    asBackup(
      async (c) =>
        (
          await c.query<{ status: string; input_tokens: number; output_tokens: number }>(
            "SELECT status, input_tokens, output_tokens FROM ai_reads ORDER BY created_at",
          )
        ).rows,
    );
  const spendFor = async (as: () => Promise<AuthedClient>) =>
    (await (await as()).inject({ method: "GET", url: "/api/v1/ai" })).json() as {
      spend: { used: number } | null;
      month: { used: number };
    };
  beforeEach(async () => {
    await switchOn();
    deps.aiPricing = { models: { "fake-1": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 } }, cap: 15 };
  });

  it("an answer LUME couldn't use is kept failed with the tokens it was billed", async () => {
    provider = unusable();
    expect((await read()).json()).toEqual({ unavailable: "failed" });
    expect(await rows()).toEqual([{ status: "failed", input_tokens: 1_000_000, output_tokens: 100_000 }]);
  });

  it("it's in the month's spend, but not against the allowance", async () => {
    provider = unusable();
    await read();
    const s = await spendFor(rep);
    expect(s.spend).toMatchObject({ used: 3 }); // 1M in at $2 + 100k out at $10
    expect(s.month.used).toBe(0);
  });

  it("good and failed reads add up together; only the good one is a read used", async () => {
    await read(); // the fake: 100 in, 30 out
    provider = unusable();
    await read();
    const s = await spendFor(rep);
    expect(s.spend).toMatchObject({ used: 3 });
    expect(s.month.used).toBe(1);
  });

  it("a provider that never answered billed nothing: the read is failed with 0 tokens", async () => {
    provider = {
      name: "fake",
      model: "fake-1",
      read: async () => {
        throw new Error("provider down");
      },
    };
    await read();
    expect(await rows()).toEqual([{ status: "failed", input_tokens: 0, output_tokens: 0 }]);
  });

  it("a rep's spend is the whole business's, reads on leads they can't see included", async () => {
    const theirs = await h.seedLead({ ownerId: ownerUser.id, name: "Arjun Mehta" });
    provider = unusable();
    await (await owner()).inject({ method: "POST", url: `/test/ai-read/${theirs}` });
    expect((await spendFor(rep)).spend).toMatchObject({ used: 3 });
    expect((await spendFor(owner)).spend).toMatchObject({ used: 3 });
  });

  it("the month is the business's: a failed read at 11:59 pm on September 30 isn't October's, one at 00:00 is", async () => {
    provider = unusable();
    await read();
    await read();
    const ids = await asBackup(
      async (c) => (await c.query<{ id: string }>("SELECT id FROM ai_reads ORDER BY created_at")).rows,
    );
    // The clock stays on October 21 (licence tokens only move forward): the reads are dated across the boundary.
    // Row security is forced on ai_reads, so the owner sees them only with every lead in scope.
    const c = await h.ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
      const a = await c.query("UPDATE ai_reads SET created_at = '2026-09-30T18:29:00Z' WHERE id = $1", [
        ids[0]!.id,
      ]);
      const b = await c.query("UPDATE ai_reads SET created_at = '2026-09-30T18:30:00Z' WHERE id = $1", [
        ids[1]!.id,
      ]);
      expect([a.rowCount, b.rowCount]).toEqual([1, 1]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect((await spendFor(rep)).spend).toMatchObject({ used: 3 }); // only the second: October 1, 00:00 in Kolkata
  });
});

/** A model per action (2026-11-12): the Haiku split runs some actions on a lighter model than the server's own. */
describe("a model per action", () => {
  beforeEach(async () => {
    await switchOn();
  });

  it("an action set to another model is read on it, kept with it, and priced at its prices", async () => {
    let asked: string | undefined;
    provider = {
      name: "fake",
      model: "fake-1",
      read: async (o) => {
        asked = o.model;
        return { ...(await fakeProvider().read(o)), inputTokens: 1_000_000, outputTokens: 0 };
      },
    };
    deps.aiModels = { next_step: "fake-light" };
    deps.aiPricing = {
      models: {
        "fake-1": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 },
        "fake-light": { in: 0.1, out: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
      },
      cap: 15,
    };
    expect((await read()).json()).toHaveProperty("output");
    expect(asked).toBe("fake-light");
    const kept = await asBackup(async (c) => (await c.query("SELECT model FROM ai_reads")).rows);
    expect(kept).toEqual([{ model: "fake-light" }]);
    const s = (await (await rep()).inject({ method: "GET", url: "/api/v1/ai" })).json();
    expect(s.spend).toMatchObject({ used: 0.1 }); // 1M input at the light model's $0.10, not $2
  });

  it("an action left alone runs on the server's own model", async () => {
    let asked: string | undefined = "unset";
    provider = {
      name: "fake",
      model: "fake-1",
      read: async (o) => {
        asked = o.model;
        return fakeProvider().read(o);
      },
    };
    deps.aiModels = { reply_meaning: "fake-light" };
    await read();
    expect(asked).toBe("fake-1");
    const kept = await asBackup(async (c) => (await c.query("SELECT model FROM ai_reads")).rows);
    expect(kept).toEqual([{ model: "fake-1" }]);
  });
});

/** AI leads (owner's spec 2026-11-12): the month's allowance counts leads, not reads. */
describe("AI leads", () => {
  const leads = (
    aiLeadsMonthly: number | null,
    o: {
      topUps?: { month: string; leads: number }[];
      calls?: number | null;
      weekly?: number | null;
      tier?: "pro" | "max" | "enterprise";
    } = {},
  ) =>
    withPlan({
      places: null,
      modules: all,
      aiReadsHourly: null,
      aiReadsWeekly: o.weekly ?? null,
      ...(o.calls !== undefined ? { aiCallsMonthly: o.calls } : {}),
      aiLeadsMonthly,
      aiLeadTopUps: o.topUps ?? [],
      ...(o.tier ? { tier: o.tier } : {}),
    });
  const status = async (as: () => Promise<AuthedClient> = owner) =>
    (await (await as()).inject({ method: "GET", url: "/api/v1/ai" })).json();
  const readOn = async (id: string, task = "next_step", as: () => Promise<AuthedClient> = owner) =>
    (await (await as()).inject({ method: "POST", url: `/test/ai-read/${id}?task=${task}` })).json();
  let others: string[] = [];
  beforeAll(async () => {
    others = [];
    for (const name of ["Arjun Mehta", "Kavya Nair", "Rohan Das", "Meera Iyer", "Vikram Rao"])
      others.push(await h.seedLead({ ownerId: repUser.id, name }));
  });
  beforeEach(async () => {
    await switchOn();
  });

  it("T1: a lead counts once a month, however many counted reads it gets", async () => {
    await leads(10);
    for (const task of ["next_step", "catch_up", "autopilot_reply", "next_step"])
      expect(await readOn(lead, task)).toHaveProperty("output");
    expect((await status()).leads).toEqual({ used: 1, limit: 10, resetsAt: "2026-10-31T18:30:00.000Z" });
    await readOn(others[0]!);
    expect((await status()).leads.used).toBe(2);
  });

  it("T2: choosing a template, a reply's meaning and drafting a template never count, even with none left", async () => {
    await leads(0); // Base
    for (const task of ["autopilot_first", "reply_meaning"])
      expect(await readOn(lead, task)).toHaveProperty("output");
    expect((await status()).leads).toMatchObject({ used: 0, limit: 0 });
    // Base: a read that counts can't start on any lead.
    expect(await readOn(lead)).toEqual({ unavailable: "leads", until: "2026-10-31T18:30:00.000Z" });
  });

  it("T2: a failed read doesn't count its lead (it stays in the spend, as before)", async () => {
    await leads(10);
    provider = {
      name: "fake",
      model: "fake-1",
      read: async () => {
        throw new AiUnreadable("refused", {
          inputTokens: 900,
          outputTokens: 40,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        });
      },
    };
    expect(await readOn(lead)).toEqual({ unavailable: "failed" });
    expect((await status()).leads.used).toBe(0);
    const tokens = await asBackup(async (c) => (await c.query("SELECT input_tokens FROM ai_reads")).rows);
    expect(tokens).toEqual([{ input_tokens: 900 }]);
  });

  it("T4: all AI leads used: a new lead is refused, a counted one keeps full AI, and admins hear once", async () => {
    await leads(1);
    expect(await readOn(lead)).toHaveProperty("output");
    expect(await readOn(others[0]!)).toEqual({ unavailable: "leads", until: "2026-10-31T18:30:00.000Z" });
    expect(await readOn(others[1]!)).toEqual({ unavailable: "leads", until: "2026-10-31T18:30:00.000Z" });
    for (let i = 0; i < 3; i++) expect(await readOn(lead, "autopilot_reply")).toHaveProperty("output");
    const full = await alerts("LUME AI has used this month's AI leads");
    expect(full.map((n) => n.user_id)).toEqual([ownerUser.id]);
    expect(full[0]!.body).toBe(
      "The month's 1 AI lead is used this month. Leads it's already working on keep it; new leads start again on November 1, or sooner with a top-up.",
    );
  });

  it("80%: admins hear once, with X of Y; and again at all of them", async () => {
    await leads(5);
    for (const id of [lead, ...others.slice(0, 3)]) await readOn(id);
    await readOn(lead); // a counted lead again: no new notice
    const eighty = await alerts("LUME AI has used 80% of this month's AI leads");
    expect(eighty.map((n) => n.body)).toEqual([
      "4 of 5 AI leads used this month. They start again on November 1.",
    ]);
    expect(await alerts("LUME AI has used this month's AI leads")).toHaveLength(0);
    await readOn(others[3]!);
    expect(await alerts("LUME AI has used this month's AI leads")).toHaveLength(1);
    expect(await alerts("LUME AI has used 80% of this month's AI leads")).toHaveLength(1);
    // The reads a month (75%/90% of an allowance) aren't said any more: they're a hidden safety net now.
    expect(await alerts("LUME AI has used 75%%")).toHaveLength(0);
  });

  it("on a tier, the notices say what to do: 100 more, or the next tier with its own AI leads", async () => {
    await leads(5, { tier: "pro" });
    for (const id of [lead, ...others.slice(0, 3)]) await readOn(id);
    expect((await alerts("LUME AI has used 80% of this month's AI leads")).map((n) => n.body)).toEqual([
      "4 of 5 AI leads used this month. They start again on November 1. Ask for 100 more from LUME AI's ring, or about Max: 3,000 AI leads a month.",
    ]);
  });

  it("T5: a lead's 20 counted reads a month, then it's refused until the 1st; cheap reads still go", async () => {
    await leads(100);
    for (let i = 0; i < 20; i++)
      expect(await readOn(lead, i % 2 ? "catch_up" : "next_step")).toHaveProperty("output");
    expect(await readOn(lead)).toEqual({ unavailable: "lead_cap", until: "2026-10-31T18:30:00.000Z" });
    expect(await readOn(lead, "autopilot_reply")).toMatchObject({ unavailable: "lead_cap" });
    expect(await readOn(lead, "autopilot_first")).toHaveProperty("output");
    // Another lead is unaffected (next month it starts again: leads.test.ts).
    expect(await readOn(others[0]!)).toHaveProperty("output");
  });

  it("no AI leads limit (null): no per-lead limit either", async () => {
    await leads(null);
    for (let i = 0; i < 21; i++) expect(await readOn(lead)).toHaveProperty("output");
    expect((await status()).leads).toMatchObject({ used: 1, limit: null });
  });

  it("the safety net: the owner's reads a month still stop LUME AI, worded without a number", async () => {
    await leads(10, { calls: 3 });
    for (let i = 0; i < 3; i++) expect(await readOn(lead)).toHaveProperty("output");
    expect(await readOn(lead)).toMatchObject({ unavailable: "limit", by: "month" });
    const notes = await alerts("LUME AI has paused%");
    expect(notes.map((n) => [n.title, n.body])).toEqual([
      [
        "LUME AI has paused for the rest of the month",
        "It reached its monthly safety limit and is back on November 1, or sooner with a top-up: ask for one from LUME AI's ring.",
      ],
    ]);
  });

  it("the safety net, when the owner set none: 30 reads an AI lead, at least 1,000", async () => {
    await leads(1);
    expect((await status()).month).toMatchObject({ limit: 1000 });
    await leads(100);
    expect((await status()).month).toMatchObject({ limit: 3000 });
  });

  it("the week doesn't apply with AI leads; the hour still does", async () => {
    await leads(10, { weekly: 1 });
    for (let i = 0; i < 3; i++) expect(await readOn(lead)).toHaveProperty("output");
    await withPlan({ places: null, modules: all, aiReadsHourly: 4, aiReadsWeekly: null, aiLeadsMonthly: 10 });
    expect(await readOn(lead)).toHaveProperty("output");
    expect(await readOn(lead)).toMatchObject({ unavailable: "limit", by: "hour" });
  });

  it("a top-up is asked against the AI leads; once one arrives, it's no longer asked", async () => {
    await leads(1);
    await readOn(lead);
    expect((await status()).topUp).toEqual({ asked: false });
    expect(
      (await (await owner()).inject({ method: "POST", url: "/api/v1/ai/topup", payload: {} })).json(),
    ).toEqual({
      asked: true,
    });
    expect((await status()).topUp).toEqual({ asked: true });
    await leads(1, { topUps: [{ month: "2026-10", leads: 100 }] });
    expect((await status()).topUp).toEqual({ asked: false });
    // The pace is the AI leads' too.
    expect((await status()).pace.daysLeft).toBeGreaterThan(30);
  });

  it("a rep sees the count too, but no top-up", async () => {
    await leads(10);
    await readOn(lead, "next_step", rep);
    expect(await status(rep)).toMatchObject({
      leads: { used: 1, limit: 10 },
      countsLeads: true,
      topUp: null,
    });
  });
});
