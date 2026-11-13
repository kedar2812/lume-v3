import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACCEPTS, moduleIncluded, planClaimSchema } from "./fleet";
import {
  moreLeadsLine,
  PLAN_TIERS,
  TIER_LINES,
  nextTier,
  repliesLocked,
  REPLY_ACTIONS,
  tierAllows,
  tierFor,
  tierName,
  tiersWith,
} from "./tiers";
import { rawPublicKey, signLicence, verifyLicence } from "./token";
import type { LicencePayload } from "./state";

/** Plans and pricing (November 2026): what each tier unlocks, held by the plan the licence server signs. */
const plan = (tier?: (typeof PLAN_TIERS)[number] | null) => ({
  places: null,
  modules: { googleSheets: true, webhooks: true, googleCalendar: true, calendly: true },
  ...(tier === undefined ? {} : { tier }),
});

describe("plan tiers", () => {
  it("Base is LUME without AI; Pro adds LUME AI; Max and Enterprise add replies and Ask me", () => {
    expect(tierAllows(plan("base"), "ai")).toBe(false);
    expect(tierAllows(plan("base"), "ai_replies")).toBe(false);
    expect(tierAllows(plan("pro"), "ai")).toBe(true);
    expect(tierAllows(plan("pro"), "ai_replies")).toBe(false);
    expect(tierAllows(plan("max"), "ai_replies")).toBe(true);
    expect(tierAllows(plan("enterprise"), "ai_replies")).toBe(true);
  });

  it("no tier (an older licence server, or a client set to none) keeps everything, as today", () => {
    for (const p of [null, undefined, plan(), plan(null)]) {
      expect(tierAllows(p, "ai")).toBe(true);
      expect(tierAllows(p, "ai_replies")).toBe(true);
    }
  });

  it("LUME AI isn't in a Base plan, even when its modules say it is", () => {
    expect(moduleIncluded({ ...plan("base"), modules: { ...plan().modules, ai: true } }, "ai")).toBe(false);
    expect(moduleIncluded(plan("pro"), "ai")).toBe(true);
    expect(moduleIncluded({ ...plan("max"), modules: { ...plan().modules, ai: false } }, "ai")).toBe(false);
    // Base leaves every other module alone.
    expect(moduleIncluded(plan("base"), "googleSheets")).toBe(true);
  });

  it("names the tier to upgrade to: the lowest one with the feature, and the one after each", () => {
    expect(tierFor("ai")).toBe("pro");
    expect(tierFor("ai_replies")).toBe("max");
    expect(nextTier("base")).toBe("pro");
    expect(nextTier("pro")).toBe("max");
    expect(nextTier("max")).toBe("enterprise");
    expect(nextTier("enterprise")).toBeNull();
    expect(tierName("enterprise")).toBe("Enterprise");
    expect(tiersWith("ai_replies")).toBe("Max and Enterprise");
    expect(tiersWith("ai")).toBe("Pro, Max and Enterprise");
  });

  it("on a tier without replies, every action LUME AI only takes inside a reply is locked", () => {
    expect(repliesLocked(plan("pro"))).toBe(true);
    expect(repliesLocked(plan("max"))).toBe(false);
    expect(repliesLocked(null)).toBe(false);
    expect(REPLY_ACTIONS).toContain("replies");
    // First messages, follow-ups and handing to a rep happen without a reply.
    expect(REPLY_ACTIONS).not.toContain("first_messages");
    expect(REPLY_ACTIONS).not.toContain("follow_ups");
    expect(REPLY_ACTIONS).not.toContain("hand_to_rep");
  });

  it("each tier's lines are its own and every higher tier's start with what it adds", () => {
    expect(TIER_LINES.base.length).toBeGreaterThan(0);
    expect(TIER_LINES.max.some((l) => /Autopilot replies/.test(l))).toBe(true);
    expect(TIER_LINES.pro.some((l) => /Autopilot replies/.test(l))).toBe(false);
  });

  it("when AI leads run low, names a top-up and the next tier's own AI leads", () => {
    expect(moreLeadsLine("pro")).toBe(
      "Ask for 100 more from LUME AI's ring, or about Max: 3,000 AI leads a month.",
    );
    expect(moreLeadsLine("max")).toBe(
      "Ask for 100 more from LUME AI's ring, or about Enterprise: 10,000 AI leads a month.",
    );
    expect(moreLeadsLine("enterprise")).toBe("Ask LUME for more AI leads from LUME AI's ring.");
    expect(moreLeadsLine(null)).toBeNull();
    expect(moreLeadsLine("base")).toBeNull();
  });

  it("a plan with a tier is only signed to a LUME that keeps it (plan6), and it verifies", () => {
    expect(ACCEPTS).toContain("plan6");
    expect(planClaimSchema.safeParse(plan("max")).success).toBe(true);
    expect(planClaimSchema.safeParse({ ...plan(), tier: "gold" }).success).toBe(false);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const now = new Date("2026-11-13T10:00:00Z");
    const p: LicencePayload = {
      v: 1,
      kid: "lume-1",
      instanceId: "LUME-K7RD-2MXQ",
      state: "active",
      licenseType: "subscription",
      issuedAt: now.toISOString(),
      validUntil: "2026-11-21T10:00:00.000Z",
      paidUntil: "2026-12-05",
      trialEndsAt: null,
      reason: "paid",
      notice: null,
      plan: plan("pro"),
    };
    const v = verifyLicence(
      signLicence(p, privateKey),
      { "lume-1": rawPublicKey(publicKey) },
      "LUME-K7RD-2MXQ",
    );
    expect(v?.plan?.tier).toBe("pro");
  });
});
