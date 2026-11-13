import { checkBody, rawPublicKey, verifyLicence } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleCheck } from "./check";
import { addTopUp, getClient, patchPlan, Refusal } from "./clients";
import type { Ctx } from "./context";
import { licenceDb, seedClient, TEST_PAIR, testCtx, type LicenceTestDb } from "./testing";

/** Control each client (spec 2026-10-17 control §1, §3). */
const KEYS = { t1: rawPublicKey(TEST_PAIR.publicKey) };
const INSTALL = "0190e0c0-0000-7000-8000-0000000000a1";
let t: LicenceTestDb;
let now = new Date("2026-10-17T09:00:00Z");
let ctx: Ctx;
const post = (c: { instanceId: string; licenseKey: string }, accepts?: string[], modulesOn?: string[]) =>
  handleCheck(
    new Request("http://licence.test/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
      body: JSON.stringify(
        checkBody({
          instanceId: c.instanceId,
          licenseKey: c.licenseKey,
          installId: INSTALL,
          appVersion: "1.5.0",
          activeUserCount: 4,
          leadCount: 300,
          now,
          ...(accepts ? { accepts } : {}),
          ...(modulesOn
            ? {
                health: {
                  uptimeS: 60,
                  dbBytes: 1,
                  diskFreePct: 50,
                  errors24h: 0,
                  queue: { waiting: 0, retrying: 0, failed24h: 0 },
                  remindersLate: 0,
                  restoreTest: null,
                  problems: [],
                  sourcesNeedingAttention: 0,
                  modulesOn: modulesOn as never,
                },
              }
            : {}),
        }),
      ),
    }),
    ctx,
  );
const payloadOf = async (r: Response, instanceId: string) =>
  verifyLicence(((await r.json()) as { token: string }).token, KEYS, instanceId);

beforeAll(async () => {
  t = await licenceDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  now = new Date("2026-10-17T09:00:00Z");
  ctx = testCtx(t.pool, () => now);
});

describe("the plan, signed", () => {
  it("goes only to a LUME that says it can keep one, with every module filled in", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await patchPlan(ctx, c.clientId, { places: 5, modules: { calendly: false } });
    expect((await payloadOf(await post(c), c.instanceId))!).not.toHaveProperty("plan");
    expect((await payloadOf(await post(c, ["announcements"]), c.instanceId))!).not.toHaveProperty("plan");
    expect((await payloadOf(await post(c, ["announcements", "plan"]), c.instanceId))!.plan).toEqual({
      places: 5,
      modules: { googleSheets: true, webhooks: true, googleCalendar: true, calendly: false },
    });
  });
  it("signs LUME AI, WhatsApp and the AI limits only for a LUME that accepts plan2", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await patchPlan(ctx, c.clientId, {
      places: 5,
      modules: { ai: false },
      aiReadsHourly: 100,
      aiReadsWeekly: 750,
    });
    const v1 = (await payloadOf(await post(c, ["announcements", "plan"]), c.instanceId))!.plan!;
    expect(Object.keys(v1.modules)).toEqual(["googleSheets", "webhooks", "googleCalendar", "calendly"]);
    expect(v1).not.toHaveProperty("aiReadsHourly");
    expect((await payloadOf(await post(c, ["announcements", "plan", "plan2"]), c.instanceId))!.plan).toEqual({
      places: 5,
      modules: {
        googleSheets: true,
        webhooks: true,
        googleCalendar: true,
        calendly: true,
        ai: false,
        whatsapp: true,
      },
      aiReadsHourly: 100,
      aiReadsWeekly: 750,
    });
  });
  it("W3b-2: signs the monthly limit on paid WhatsApp messages only for a LUME that accepts plan3", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await patchPlan(ctx, c.clientId, { places: null, modules: {}, paidSendsMonthly: 1000 });
    const v2 = (await payloadOf(await post(c, ["announcements", "plan", "plan2"]), c.instanceId))!.plan!;
    expect(v2).not.toHaveProperty("paidSendsMonthly");
    const v3 = (await payloadOf(await post(c, ["announcements", "plan", "plan2", "plan3"]), c.instanceId))!
      .plan!;
    expect(v3.paidSendsMonthly).toBe(1000);
  });
  it("Autopilot A1: signs LUME AI a month and the top-ups around this month only for a LUME that accepts plan4", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-31" });
    await patchPlan(ctx, c.clientId, { places: null, modules: {}, aiCallsMonthly: 3000 });
    // Top-ups in calls, as they were added before AI leads (2026-11-12): kept, and still signed to an older LUME.
    for (const [month, calls] of [
      ["2026-10", 500],
      ["2026-10", 250],
      ["2026-04", 900],
    ] as const)
      await t.pool.query("INSERT INTO ai_topups (client_id, month, calls) VALUES ($1, $2, $3)", [
        c.clientId,
        month,
        calls,
      ]);
    const v3 = (await payloadOf(await post(c, ["announcements", "plan", "plan2", "plan3"]), c.instanceId))!
      .plan!;
    expect(v3).not.toHaveProperty("aiCallsMonthly");
    expect(v3).not.toHaveProperty("aiTopUps");
    const v4 = (await payloadOf(
      await post(c, ["announcements", "plan", "plan2", "plan3", "plan4"]),
      c.instanceId,
    ))!.plan!;
    expect(v4.aiCallsMonthly).toBe(3000);
    // The month before, this one and the next (the client's clock may be a day either side of the server's): one
    // entry a month, its top-ups added up; April's long gone.
    expect(v4.aiTopUps).toEqual([{ month: "2026-10", calls: 750 }]);
  });

  it("Autopilot A1: keeps LUME AI a month and says it in the history", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-31" });
    const r = await patchPlan(ctx, c.clientId, { places: null, modules: {}, aiCallsMonthly: 5000 });
    expect(r.plan).toMatchObject({ aiCallsMonthly: 5000 });
    expect(r.history[0]).toMatchObject({ kind: "plan", detail: { aiCallsMonthly: 5000 } });
    await expect(
      patchPlan(ctx, c.clientId, { places: null, modules: {}, aiCallsMonthly: 0 }),
    ).rejects.toThrow("LUME AI a month: at least 1, or no limit.");
  });

  it("is no limit and everything included until it's set", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    expect((await payloadOf(await post(c, ["plan"]), c.instanceId))!.plan).toEqual({
      places: null,
      modules: { googleSheets: true, webhooks: true, googleCalendar: true, calendly: true },
    });
  });
});

describe("PATCH /api/clients/:id/plan", () => {
  it("saves it, writes it to the history in words, and the client shows it with what their LUME uses", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await post(c, ["announcements", "plan"], ["webhooks", "calendly"]);
    const r = await patchPlan(ctx, c.clientId, {
      places: 5,
      modules: { calendly: false, googleSheets: false },
    });
    expect(r.plan).toEqual({
      places: 5,
      modules: {
        googleSheets: false,
        webhooks: true,
        googleCalendar: true,
        calendly: false,
        ai: true,
        whatsapp: true,
      },
      aiReadsHourly: null,
      aiReadsWeekly: null,
      paidSendsMonthly: null,
      // Autopilot A1: LUME AI a month and its top-ups are on the client's page whether or not their LUME knows them.
      aiCallsMonthly: null,
      aiTopUps: [],
      // AI leads (2026-11-12): likewise, none set is no limit.
      aiLeadsMonthly: null,
      aiLeadTopUps: [],
    });
    expect(r.usage).toEqual({
      people: 4,
      modulesOn: ["webhooks", "calendly"],
      knows: true,
      knowsAi: false,
      knowsPaid: false,
      knowsMonthly: false,
      knowsLeads: false,
    });
    expect(r.history[0]).toMatchObject({
      kind: "plan",
      detail: { places: 5, left: ["googleSheets", "calendly"] },
    });
    const again = await getClient(ctx, c.clientId);
    expect(again.plan.places).toBe(5);
  });
  it("keeps the AI limits and says them in the history", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await post(c, ["announcements", "plan", "plan2"], ["ai"]);
    const r = await patchPlan(ctx, c.clientId, {
      places: null,
      modules: {},
      aiReadsHourly: 40,
      aiReadsWeekly: 250,
    });
    expect(r.plan).toMatchObject({ aiReadsHourly: 40, aiReadsWeekly: 250 });
    expect(r.usage).toMatchObject({ modulesOn: ["ai"], knowsAi: true });
    expect(r.history[0]).toMatchObject({
      kind: "plan",
      detail: { places: null, left: [], aiReadsHourly: 40, aiReadsWeekly: 250 },
    });
  });
  it("W3b-2: keeps the paid-message limit, says it in the history, and refuses one out of bounds", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await post(c, ["announcements", "plan", "plan2", "plan3"]);
    const r = await patchPlan(ctx, c.clientId, { places: null, modules: {}, paidSendsMonthly: 2500 });
    expect(r.plan).toMatchObject({ paidSendsMonthly: 2500 });
    expect(r.usage).toMatchObject({ knowsPaid: true });
    expect(r.history[0]).toMatchObject({ kind: "plan", detail: { paidSendsMonthly: 2500 } });
    await expect(
      patchPlan(ctx, c.clientId, { places: null, modules: {}, paidSendsMonthly: 0 }),
    ).rejects.toThrow("Paid WhatsApp messages a month: at least 1, or no limit.");
  });
  it("on an older LUME says it can't keep one yet", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await post(c);
    expect((await getClient(ctx, c.clientId)).usage).toMatchObject({ knows: false });
  });
  it("refuses places out of bounds or a module it doesn't know, and writes nothing when nothing changes", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await expect(patchPlan(ctx, c.clientId, { places: 0, modules: {} })).rejects.toBeInstanceOf(Refusal);
    await expect(patchPlan(ctx, c.clientId, { places: 10_001, modules: {} })).rejects.toBeInstanceOf(Refusal);
    await expect(
      patchPlan(ctx, c.clientId, { places: null, modules: { instagram: false } as never }),
    ).rejects.toBeInstanceOf(Refusal);
    await expect(
      patchPlan(ctx, c.clientId, { places: null, modules: {}, aiReadsHourly: 0 }),
    ).rejects.toBeInstanceOf(Refusal);
    await expect(
      patchPlan(ctx, c.clientId, { places: null, modules: {}, aiReadsWeekly: 1_000_001 }),
    ).rejects.toBeInstanceOf(Refusal);
    const before = (await getClient(ctx, c.clientId)).history.length;
    await patchPlan(ctx, c.clientId, { places: null, modules: {} });
    expect((await getClient(ctx, c.clientId)).history.length).toBe(before);
  });
});

/** AI leads (owner's spec 2026-11-12 §2, §7): the plan counts AI leads a month; top-ups are packs of 100 for a month. */
describe("AI leads, signed", () => {
  const ALL5 = ["announcements", "plan", "plan2", "plan3", "plan4", "plan5"];
  const ALL4 = ["announcements", "plan", "plan2", "plan3", "plan4"];
  const planFor = async (c: { instanceId: string; licenseKey: string }, accepts: string[]) =>
    (await payloadOf(await post(c, accepts), c.instanceId))!.plan!;

  it("a LUME that accepts plan5 gets its AI leads, this month's packs, and the safety net as set (empty: automatic)", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-31" });
    await patchPlan(ctx, c.clientId, { places: null, modules: {}, aiLeadsMonthly: 1000 });
    await addTopUp(ctx, c.clientId, { month: "2026-10", packs: 2 });
    await addTopUp(ctx, c.clientId, { month: "2026-10", packs: 1, note: "Diwali rush" });
    const p = await planFor(c, ALL5);
    expect(p.aiLeadsMonthly).toBe(1000);
    expect(p.aiLeadTopUps).toEqual([{ month: "2026-10", leads: 300 }]);
    // No number of the owner's: the client's LUME sizes the safety net itself (30 actions an AI lead).
    expect(p.aiCallsMonthly).toBeNull();
    expect(p.aiTopUps).toEqual([]);
    await patchPlan(ctx, c.clientId, {
      places: null,
      modules: {},
      aiLeadsMonthly: 1000,
      aiCallsMonthly: 50_000,
    });
    expect((await planFor(c, ALL5)).aiCallsMonthly).toBe(50_000);
  });

  it("an older LUME (plan4) gets 7 actions for each AI lead and each pack, unless the owner set its own", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-31" });
    await patchPlan(ctx, c.clientId, { places: null, modules: {}, aiLeadsMonthly: 1000 });
    await addTopUp(ctx, c.clientId, { month: "2026-10", packs: 1 });
    const p = await planFor(c, ALL4);
    expect(p).not.toHaveProperty("aiLeadsMonthly");
    expect(p).not.toHaveProperty("aiLeadTopUps");
    expect(p.aiCallsMonthly).toBe(7000);
    expect(p.aiTopUps).toEqual([{ month: "2026-10", calls: 700 }]);
    await patchPlan(ctx, c.clientId, {
      places: null,
      modules: {},
      aiLeadsMonthly: 1000,
      aiCallsMonthly: 9000,
    });
    expect((await planFor(c, ALL4)).aiCallsMonthly).toBe(9000);
  });

  it("Base (0 AI leads): plan5 is told 0; an older LUME has LUME AI off (it can't be told 0)", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-31" });
    await patchPlan(ctx, c.clientId, { places: null, modules: {}, aiLeadsMonthly: 0 });
    const v5 = await planFor(c, ALL5);
    expect(v5.aiLeadsMonthly).toBe(0);
    expect(v5.modules.ai).toBe(true);
    const v4 = await planFor(c, ALL4);
    expect(v4.modules.ai).toBe(false);
    expect(v4.aiCallsMonthly).toBeNull();
  });

  it("no AI leads limit: plan5 is told none, and an older LUME keeps the owner's monthly number or none", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-31" });
    expect((await planFor(c, ALL5)).aiLeadsMonthly).toBeNull();
    expect((await planFor(c, ALL4)).aiCallsMonthly).toBeNull();
  });

  it("keeps AI leads, says them in the history, and refuses a number out of bounds", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-31" });
    const r = await patchPlan(ctx, c.clientId, { places: null, modules: {}, aiLeadsMonthly: 3000 });
    expect(r.plan).toMatchObject({ aiLeadsMonthly: 3000 });
    expect(r.history[0]).toMatchObject({ kind: "plan", detail: { aiLeadsMonthly: 3000 } });
    await expect(
      patchPlan(ctx, c.clientId, { places: null, modules: {}, aiLeadsMonthly: -1 }),
    ).rejects.toThrow("AI leads a month: 0 or more, or no limit.");
    await expect(
      patchPlan(ctx, c.clientId, { places: null, modules: {}, aiLeadsMonthly: 10_000_001 }),
    ).rejects.toThrow(/^AI leads a month: .* at most\.$/);
  });

  it("T6: a pack is for its month: this month's, the next month's plan has none of it", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2027-12-31" });
    await patchPlan(ctx, c.clientId, { places: null, modules: {}, aiLeadsMonthly: 100 });
    await addTopUp(ctx, c.clientId, { month: "2026-10", packs: 1 });
    now = new Date("2026-12-05T09:00:00Z");
    ctx = testCtx(t.pool, () => now);
    expect((await planFor(c, ALL5)).aiLeadTopUps).toEqual([]);
  });

  it("a top-up is packs of 100, for the client's month now only (the open request's, or this one ±1 for their clock)", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-31" });
    await expect(addTopUp(ctx, c.clientId, { month: "2026-10", packs: 0 })).rejects.toThrow(
      "At least 1 pack.",
    );
    await expect(addTopUp(ctx, c.clientId, { month: "2026-10", packs: 1.5 })).rejects.toThrow(
      "A top-up is a whole number of packs.",
    );
    await expect(addTopUp(ctx, c.clientId, { month: "2026-08", packs: 1 })).rejects.toThrow(
      "A top-up is for this month only.",
    );
    await expect(addTopUp(ctx, c.clientId, { month: "2027-01", packs: 1 })).rejects.toThrow(
      "A top-up is for this month only.",
    );
    const r = await addTopUp(ctx, c.clientId, { month: "2026-10", packs: 3, note: "Busy week" });
    expect(r.topUps.added[0]).toMatchObject({ month: "2026-10", leads: 300, note: "Busy week" });
    expect(r.history[0]).toMatchObject({ kind: "ai_topup", detail: { month: "2026-10", leads: 300 } });
  });
});

describe("migration 0012: existing licences move to AI leads", () => {
  it("a monthly number becomes AI leads (÷ 7, up to the next 100, at least 100); none stays none; top-ups stay", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../migrations/0012_ai_leads.sql", import.meta.url), "utf8");
    const move = /-- move:start\n([\s\S]*?)-- move:end/.exec(sql)![1]!;
    const a = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-31" });
    const b = await seedClient(t.pool, { type: "perpetual" });
    const small = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-31" });
    await t.pool.query(
      "UPDATE licences SET ai_calls_monthly = 3000, ai_leads_monthly = NULL WHERE client_id = $1",
      [a.clientId],
    );
    await t.pool.query(
      "UPDATE licences SET ai_calls_monthly = NULL, ai_leads_monthly = NULL WHERE client_id = $1",
      [b.clientId],
    );
    await t.pool.query(
      "UPDATE licences SET ai_calls_monthly = 50, ai_leads_monthly = NULL WHERE client_id = $1",
      [small.clientId],
    );
    await t.pool.query(move);
    const rows = async (id: string) =>
      (
        await t.pool.query("SELECT ai_leads_monthly, ai_calls_monthly FROM licences WHERE client_id = $1", [
          id,
        ])
      ).rows[0];
    // 3,000 a month is about 429 AI leads: 500, and an older LUME is signed 3,500 (never less than it had).
    expect(await rows(a.clientId)).toEqual({ ai_leads_monthly: 500, ai_calls_monthly: null });
    expect(await rows(b.clientId)).toEqual({ ai_leads_monthly: null, ai_calls_monthly: null });
    expect(await rows(small.clientId)).toEqual({ ai_leads_monthly: 100, ai_calls_monthly: null });
  });
});
