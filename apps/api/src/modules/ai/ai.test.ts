import { generateKeyPairSync } from "node:crypto";
import {
  ALL_GRANTS,
  nextStepOutput,
  rawPublicKey,
  signLicence,
  type LicencePayload,
  type PlanClaim,
} from "@lume/core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { fakeProvider } from "../../ai/fake";
import type { AiProvider } from "../../ai/provider";
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
      app.post<{ Params: { id: string } }>(
        "/test/ai-read/:id",
        { config: { permission: "leads.view" } },
        (req) =>
          runRead(req, d, {
            task: "next_step",
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
  // No read is ever deleted (no delete policy, by design): the owner empties the table between tests.
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices");
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
    const status = async () => (await (await owner()).inject({ method: "GET", url: "/api/v1/ai" })).json().topUp;
    expect(await status()).toEqual({ asked: true });
    await monthly(1, [{ month: "2026-10", calls: 1 }]);
    expect(await status()).toEqual({ asked: false });
    const second = await (await owner()).inject({ method: "POST", url: "/api/v1/ai/topup", payload: {} });
    expect(second.statusCode).toBe(200);
    expect(topUpCalls).toHaveLength(2);
    expect(await status()).toEqual({ asked: true });
  });
});
