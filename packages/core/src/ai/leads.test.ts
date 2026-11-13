import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACCEPTS, aiAllowance, aiLeadAllowance, aiSafetyMonthly, usesLeads } from "../licence/fleet";
import { rawPublicKey, signLicence, verifyLicence } from "../licence/token";
import type { LicencePayload } from "../licence/state";
import {
  AI_COUNTED_TASKS,
  AI_LEAD_ACTIONS_MAX,
  AI_LEAD_TIERS,
  AI_TOP_UP_PACK,
  aiCallsForOlder,
  isCountedTask,
} from "./leads";
import { aiLimitState } from "./limits";
import { AI_TASKS } from "./tasks";

/** AI leads (owner's spec 2026-11-12): LUME AI's allowance counts leads a month, not actions. */
const now = new Date("2026-11-12T10:00:00Z");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = { "lume-1": rawPublicKey(publicKey) };
const payload = (plan: unknown): LicencePayload => ({
  v: 1,
  kid: "lume-1",
  instanceId: "LUME-K7RD-2MXQ",
  state: "active",
  licenseType: "subscription",
  issuedAt: now.toISOString(),
  validUntil: "2026-11-20T10:00:00.000Z",
  paidUntil: "2026-12-05",
  trialEndsAt: null,
  reason: "paid",
  notice: null,
  plan: plan as never,
});
const base = {
  places: 5,
  modules: { googleSheets: true, webhooks: true, googleCalendar: true, calendly: true },
};
const signed = (p: unknown) => verifyLicence(signLicence(payload(p), privateKey), keys, "LUME-K7RD-2MXQ");

describe("what counts", () => {
  it("only an Autopilot reply, Suggest next step and Catch me up count; the cheap reads never do", () => {
    expect([...AI_COUNTED_TASKS].sort()).toEqual(["autopilot_reply", "catch_up", "next_step"]);
    for (const t of AI_TASKS)
      expect(isCountedTask(t)).toBe(["autopilot_reply", "catch_up", "next_step"].includes(t));
    expect(isCountedTask("autopilot_first")).toBe(false);
    expect(isCountedTask("reply_meaning")).toBe(false);
    expect(isCountedTask("template_draft")).toBe(false);
  });
  it("20 counted actions a lead a month; top-ups in packs of 100", () => {
    expect(AI_LEAD_ACTIONS_MAX).toBe(20);
    expect(AI_TOP_UP_PACK).toBe(100);
  });
  it("the tiers: Base 0, Pro 1,000, Max 3,000, Enterprise 10,000", () => {
    expect(AI_LEAD_TIERS.map((t) => [t.name, t.leads])).toEqual([
      ["Base", 0],
      ["Pro", 1000],
      ["Max", 3000],
      ["Enterprise", 10000],
    ]);
  });
});

describe("the licence signs AI leads (plan5)", () => {
  it("a LUME from this release accepts plan5", () => {
    expect(ACCEPTS).toContain("plan5");
  });
  it("AI leads a month from 0 (Base) to 10,000,000, or none; this month's top-ups in leads", () => {
    const p = signed({
      ...base,
      aiLeadsMonthly: 1000,
      aiLeadTopUps: [
        { month: "2026-11", leads: 100 },
        { month: "2026-11", leads: 200 },
        { month: "2026-10", leads: 500 },
      ],
    })!.plan!;
    expect(usesLeads(p)).toBe(true);
    expect(aiLeadAllowance(p, "2026-11")).toBe(1300);
    // T6: a top-up is for its month only; the next month is the plan's again.
    expect(aiLeadAllowance(p, "2026-12")).toBe(1000);
    expect(aiLeadAllowance(signed({ ...base, aiLeadsMonthly: 0 })!.plan!, "2026-11")).toBe(0);
    expect(aiLeadAllowance(signed({ ...base, aiLeadsMonthly: null })!.plan!, "2026-11")).toBeNull();
    expect(signed({ ...base, aiLeadsMonthly: -1 })).toBeNull();
    expect(signed({ ...base, aiLeadsMonthly: 10_000_001 })).toBeNull();
    expect(signed({ ...base, aiLeadsMonthly: 1.5 })).toBeNull();
    expect(
      signed({ ...base, aiLeadsMonthly: 10, aiLeadTopUps: [{ month: "2026-11", leads: 0 }] }),
    ).toBeNull();
    expect(signed({ ...base, aiLeadsMonthly: 10, aiLeadTopUps: [{ month: "Nov", leads: 5 }] })).toBeNull();
  });
  it("a plan without AI leads (an older licence server) doesn't count leads", () => {
    expect(usesLeads({ ...base, aiCallsMonthly: 3000 } as never)).toBe(false);
    expect(usesLeads(null)).toBe(false);
    expect(aiLeadAllowance({ ...base, aiCallsMonthly: 3000 } as never, "2026-11")).toBeNull();
  });
});

describe("the safety net (hidden)", () => {
  const plan = (o: object) => ({ ...base, ...o }) as never;
  it("the owner's own monthly number when it's set, with its call top-ups", () => {
    const p = plan({
      aiLeadsMonthly: 1000,
      aiCallsMonthly: 50_000,
      aiTopUps: [{ month: "2026-11", calls: 10 }],
    });
    expect(aiSafetyMonthly(p, "2026-11")).toBe(50_010);
  });
  it("else 30 actions an AI lead, top-ups included, and never under 1,000", () => {
    expect(aiSafetyMonthly(plan({ aiLeadsMonthly: 1000 }), "2026-11")).toBe(30_000);
    expect(
      aiSafetyMonthly(
        plan({ aiLeadsMonthly: 1000, aiLeadTopUps: [{ month: "2026-11", leads: 100 }] }),
        "2026-11",
      ),
    ).toBe(33_000);
    expect(aiSafetyMonthly(plan({ aiLeadsMonthly: 0 }), "2026-11")).toBe(1000);
    expect(aiSafetyMonthly(plan({ aiLeadsMonthly: 10 }), "2026-11")).toBe(1000);
  });
  it("no AI leads limit and no monthly number: no safety net beyond the hour", () => {
    expect(aiSafetyMonthly(plan({ aiLeadsMonthly: null }), "2026-11")).toBeNull();
    expect(aiSafetyMonthly(null, "2026-11")).toBeNull();
  });
  it("an older licence (plan4 only) keeps its monthly calls as the allowance it always was", () => {
    expect(aiSafetyMonthly(plan({ aiCallsMonthly: 3000 }), "2026-11")).toBe(
      aiAllowance(plan({ aiCallsMonthly: 3000 }), "2026-11"),
    );
  });
});

describe("what an older LUME is signed", () => {
  it("7 calls an AI lead (the measured average); none for no limit", () => {
    expect(aiCallsForOlder(1000)).toBe(7000);
    expect(aiCallsForOlder(null)).toBeNull();
  });
});

describe("the state counts AI leads", () => {
  const TZ = "Asia/Kolkata";
  it("X of Y AI leads this month, resetting on the 1st on the business's clock", () => {
    const s = aiLimitState(
      { hourN: 0, hourOldest: null, weekN: 0, monthN: 40, leadsN: 812 },
      { hourly: null, weekly: null, monthly: 30_000, leads: 1000 },
      now,
      TZ,
    );
    expect(s.leads).toEqual({ used: 812, limit: 1000, resetsAt: "2026-11-30T18:30:00.000Z" });
    expect(s.paused).toBeNull();
  });
  it("all AI leads used isn't a pause: counted leads keep LUME AI", () => {
    const s = aiLimitState(
      { hourN: 0, hourOldest: null, weekN: 0, monthN: 40, leadsN: 1000 },
      { hourly: null, weekly: null, monthly: 30_000, leads: 1000 },
      now,
      TZ,
    );
    expect(s.leads.used).toBe(1000);
    expect(s.paused).toBeNull();
  });
  it("no AI leads limit: the count still shows, with no limit", () => {
    const s = aiLimitState(
      { hourN: 0, hourOldest: null, weekN: 0, leadsN: 3 },
      { hourly: null, weekly: null },
      now,
      TZ,
    );
    expect(s.leads).toEqual({ used: 3, limit: null, resetsAt: "2026-11-30T18:30:00.000Z" });
  });
});
