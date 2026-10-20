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
    await addTopUp(ctx, c.clientId, { month: "2026-10", calls: 500 });
    await addTopUp(ctx, c.clientId, { month: "2026-10", calls: 250 });
    await addTopUp(ctx, c.clientId, { month: "2026-04", calls: 900 });
    const v3 = (await payloadOf(await post(c, ["announcements", "plan", "plan2", "plan3"]), c.instanceId))!.plan!;
    expect(v3).not.toHaveProperty("aiCallsMonthly");
    expect(v3).not.toHaveProperty("aiTopUps");
    const v4 = (await payloadOf(await post(c, ["announcements", "plan", "plan2", "plan3", "plan4"]), c.instanceId))!
      .plan!;
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
    await expect(patchPlan(ctx, c.clientId, { places: null, modules: {}, aiCallsMonthly: 0 })).rejects.toThrow(
      "LUME AI a month: at least 1, or no limit.",
    );
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
    });
    expect(r.usage).toEqual({
      people: 4,
      modulesOn: ["webhooks", "calendly"],
      knows: true,
      knowsAi: false,
      knowsPaid: false,
      knowsMonthly: false,
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
