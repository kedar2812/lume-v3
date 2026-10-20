import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACCEPTS, aiAllowance, fleetHealthSchema, moduleIncluded, PLAN_MODULES, usesMonthly } from "./fleet";
import { licenceState, type LicencePayload } from "./state";
import { rawPublicKey, signLicence, verifyLicence } from "./token";

/** Control each client (spec 2026-10-17 control §1): places and modules, signed. */
const now = new Date("2026-10-17T10:00:00Z");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = { "lume-1": rawPublicKey(publicKey) };
const payload = (over: Partial<LicencePayload> = {}): LicencePayload => ({
  v: 1,
  kid: "lume-1",
  instanceId: "LUME-K7RD-2MXQ",
  state: "active",
  licenseType: "subscription",
  issuedAt: now.toISOString(),
  validUntil: "2026-10-25T10:00:00.000Z",
  paidUntil: "2026-11-05",
  trialEndsAt: null,
  reason: "paid",
  notice: null,
  ...over,
});
const plan = {
  places: 5,
  modules: { googleSheets: true, webhooks: true, googleCalendar: true, calendly: false },
};
const view = (p: LicencePayload) =>
  licenceState({ payload: p, lastSuccessAt: now, firstBootAt: now, now, dev: false });

describe("the plan in the signed answer", () => {
  it("verifies with places and the four modules, and LUME says it can keep one", () => {
    const t = signLicence(payload({ plan }), privateKey);
    expect(verifyLicence(t, keys, "LUME-K7RD-2MXQ")?.plan).toEqual(plan);
    expect(PLAN_MODULES).toEqual([
      "googleSheets",
      "webhooks",
      "googleCalendar",
      "calendly",
      "ai",
      "whatsapp",
    ]);
    expect(ACCEPTS).toEqual(["announcements", "plan", "plan2", "plan3", "plan4"]);
  });
  it("W3b-2: a monthly limit on paid WhatsApp messages, within bounds", () => {
    const sign = (p: unknown) =>
      verifyLicence(signLicence(payload({ plan: p as never }), privateKey), keys, "LUME-K7RD-2MXQ");
    expect(sign({ ...plan, paidSendsMonthly: 1000 })?.plan?.paidSendsMonthly).toBe(1000);
    expect(sign({ ...plan, paidSendsMonthly: null })).not.toBeNull();
    expect(sign({ ...plan, paidSendsMonthly: 0 })).toBeNull();
    expect(sign({ ...plan, paidSendsMonthly: 10_000_001 })).toBeNull();
  });
  it("Autopilot A1: LUME AI a month, with this month's top-ups, within bounds", () => {
    const sign = (p: unknown) =>
      verifyLicence(signLicence(payload({ plan: p as never }), privateKey), keys, "LUME-K7RD-2MXQ");
    const ok = sign({
      ...plan,
      aiCallsMonthly: 3000,
      aiTopUps: [
        { month: "2026-10", calls: 500 },
        { month: "2026-09", calls: 900 },
      ],
    })!.plan!;
    expect(aiAllowance(ok, "2026-10")).toBe(3500);
    expect(aiAllowance(ok, "2026-11")).toBe(3000);
    expect(usesMonthly(ok)).toBe(true);
    expect(sign({ ...plan, aiCallsMonthly: 0 })).toBeNull();
    expect(sign({ ...plan, aiCallsMonthly: 10_000_001 })).toBeNull();
    expect(sign({ ...plan, aiCallsMonthly: 3000, aiTopUps: [{ month: "October", calls: 5 }] })).toBeNull();
    const many = Array.from({ length: 13 }, (_, i) => ({
      month: `2026-${String((i % 12) + 1).padStart(2, "0")}`,
      calls: 1,
    }));
    expect(sign({ ...plan, aiCallsMonthly: 3000, aiTopUps: many })).toBeNull();
  });
  it("a plan from an older licence server has no monthly allowance (it keeps the weekly)", () => {
    expect(usesMonthly({ ...plan, aiReadsWeekly: 750 } as never)).toBe(false);
    expect(aiAllowance({ ...plan, aiCallsMonthly: null } as never, "2026-10")).toBeNull();
    expect(usesMonthly(null)).toBe(false);
  });
  it("refuses a module it doesn't know, or places out of bounds", () => {
    const bad = (p: unknown) =>
      verifyLicence(signLicence(payload({ plan: p as never }), privateKey), keys, "LUME-K7RD-2MXQ");
    expect(bad({ ...plan, modules: { ...plan.modules, instagram: true } })).toBeNull();
    expect(bad({ ...plan, places: 0 })).toBeNull();
    expect(bad({ ...plan, places: 10_001 })).toBeNull();
    expect(bad({ ...plan, places: null })).not.toBeNull();
  });
  it("a plan without ai or whatsapp parses (an older licence server), and they count as included", () => {
    const t = signLicence(payload({ plan }), privateKey);
    const p = verifyLicence(t, keys, "LUME-K7RD-2MXQ")!.plan!;
    expect(moduleIncluded(p, "ai")).toBe(true);
    expect(moduleIncluded(p, "whatsapp")).toBe(true);
    expect(moduleIncluded(p, "calendly")).toBe(false);
    expect(moduleIncluded(null, "calendly")).toBe(true);
    const v2 = {
      ...plan,
      modules: { ...plan.modules, ai: false, whatsapp: true },
      aiReadsHourly: 100,
      aiReadsWeekly: 750,
    };
    const back = verifyLicence(signLicence(payload({ plan: v2 }), privateKey), keys, "LUME-K7RD-2MXQ")!.plan!;
    expect(back).toEqual(v2);
    expect(moduleIncluded(back, "ai")).toBe(false);
  });
  it("AI limits are whole numbers from 1, or none", () => {
    const sign = (p: unknown) =>
      verifyLicence(signLicence(payload({ plan: p as never }), privateKey), keys, "LUME-K7RD-2MXQ");
    expect(sign({ ...plan, aiReadsHourly: 0 })).toBeNull();
    expect(sign({ ...plan, aiReadsWeekly: 0 })).toBeNull();
    expect(sign({ ...plan, aiReadsHourly: 100_001 })).toBeNull();
    expect(sign({ ...plan, aiReadsWeekly: 1.5 })).toBeNull();
    expect(sign({ ...plan, aiReadsHourly: null, aiReadsWeekly: null })).not.toBeNull();
  });
  it("the view carries the plan, or null when the answer has none (no limits)", () => {
    expect(view(payload({ plan })).plan).toEqual(plan);
    expect(view(payload()).plan).toBeNull();
  });
  it("health may say which modules are on, by their keys only", () => {
    const base = {
      uptimeS: 1,
      dbBytes: 1,
      diskFreePct: null,
      errors24h: 0,
      queue: { waiting: 0, retrying: 0, failed24h: 0 },
      remindersLate: 0,
      restoreTest: null,
      problems: [],
      sourcesNeedingAttention: 0,
    };
    expect(fleetHealthSchema.safeParse({ ...base, modulesOn: ["webhooks", "calendly"] }).success).toBe(true);
    expect(fleetHealthSchema.safeParse({ ...base, modulesOn: ["ai", "whatsapp"] }).success).toBe(true);
    expect(fleetHealthSchema.safeParse({ ...base, modulesOn: ["Instagram sheet"] }).success).toBe(false);
    expect(fleetHealthSchema.safeParse(base).success).toBe(true);
  });
});
