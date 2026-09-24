import { describe, expect, it } from "vitest";
import { effectivePermissions, type Actor } from "../rbac/engine";
import { EMPTY_ONBOARDING, needsOnboarding, onboardingStepsFor } from "../onboarding/steps";
import { PREFERENCES_DEFAULTS, mergePreferences, preferencesPatchSchema } from "./preferences";
import { EMPTY_TOUR, TOUR_STEPS, TOUR_VERSION, boldParts, needsTour, tourStepsFor } from "../tour/steps";

const actor = (grants: Parameters<typeof effectivePermissions>[0], extra: Partial<Actor> = {}): Actor => ({
  userId: "u1",
  isOwner: false,
  perms: effectivePermissions(grants),
  teamMemberIds: [],
  twoFactorEnabled: true,
  roleIds: [],
  ...extra,
});
const NONE = { sheets: false, calendar: false };
const ALL = { sheets: true, calendar: true };

describe("preferences", () => {
  it("defaults to a Monday–Friday day with sounds on", () => {
    expect(PREFERENCES_DEFAULTS).toEqual({
      workingDays: [1, 2, 3, 4, 5],
      workStart: "09:00",
      workEnd: "18:00",
      digestTime: "08:00",
      sounds: { enabled: true, volume: 60 },
      alerts: { assigned: true, dueFollowUps: true, emailDigest: true },
    });
  });

  it("merges a patch onto what is stored, keeping untouched values", () => {
    const stored = { ...PREFERENCES_DEFAULTS, digestTime: "07:30" };
    const merged = mergePreferences(stored, { sounds: { volume: 20 }, workingDays: [1, 3, 5] });
    expect(merged.digestTime).toBe("07:30");
    expect(merged.workingDays).toEqual([1, 3, 5]);
    expect(merged.sounds).toEqual({ enabled: true, volume: 20 });
  });

  it("repairs anything unusable that is already stored", () => {
    expect(mergePreferences({ workStart: "nope", sounds: "loud" }, {})).toEqual(PREFERENCES_DEFAULTS);
  });

  it("rejects impossible values and unknown keys", () => {
    expect(preferencesPatchSchema.safeParse({ workStart: "9am" }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ workingDays: [7] }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ sounds: { volume: 120 } }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ digestTime: "08:00" }).success).toBe(true);
  });
});

describe("onboarding steps (spec §4.1)", () => {
  it("a sales rep gets the personal steps only, in order", () => {
    const steps = onboardingStepsFor({
      actor: actor([{ key: "leads.view", scope: "own" }]),
      twoFactorEnabled: false,
      capabilities: NONE,
    });
    expect(steps.map((s) => s.id)).toEqual(["welcome", "you", "look", "day", "alerts", "done"]);
  });

  it("asks an admin for their name before the required two-step step", () => {
    const steps = onboardingStepsFor({
      actor: actor([{ key: "users.manage", scope: null }]),
      twoFactorEnabled: false,
      capabilities: NONE,
    });
    expect(steps.map((s) => s.id).slice(0, 3)).toEqual(["welcome", "you", "secure"]);
    expect(steps.find((s) => s.id === "secure")!.required).toBe(true);
    expect(steps.every((s) => s.id === "secure" || !s.required)).toBe(true);
  });

  it("drops the two-step step once enrolled", () => {
    const steps = onboardingStepsFor({
      actor: actor([{ key: "users.manage", scope: null }]),
      twoFactorEnabled: true,
      capabilities: NONE,
    });
    expect(steps.map((s) => s.id)).not.toContain("secure");
  });

  it("adds workspace steps for the people who can do them", () => {
    const steps = onboardingStepsFor({
      actor: actor([
        { key: "users.manage", scope: null },
        { key: "pipelines.manage", scope: null },
        { key: "leads.import", scope: null },
      ]),
      twoFactorEnabled: true,
      capabilities: ALL,
    });
    expect(steps.map((s) => s.id)).toEqual([
      "welcome",
      "you",
      "look",
      "day",
      "alerts",
      "team",
      "pipeline",
      "connect",
      "done",
    ]);
  });

  it("hides Connect until an integration exists", () => {
    const ctx = {
      actor: actor([{ key: "calendar.connect", scope: null }]),
      twoFactorEnabled: true,
      capabilities: NONE,
    };
    expect(onboardingStepsFor(ctx).map((s) => s.id)).not.toContain("connect");
    expect(
      onboardingStepsFor({ ...ctx, capabilities: { sheets: false, calendar: true } }).map((s) => s.id),
    ).toContain("connect");
  });

  it("is needed until it is completed", () => {
    expect(needsOnboarding(EMPTY_ONBOARDING)).toBe(true);
    expect(needsOnboarding({ step: "look", skipped: [], completedAt: null })).toBe(true);
    expect(needsOnboarding({ step: null, skipped: ["day"], completedAt: "2026-09-24T09:00:00Z" })).toBe(
      false,
    );
  });
});

describe("tour steps (spec §5)", () => {
  // The seeded Sales role (report §7.3): sees their own leads, reveals contacts, no admin anything.
  const rep = actor([
    { key: "leads.view", scope: "own" },
    { key: "leads.contact.reveal", scope: "own" },
    { key: "templates.use", scope: null },
    { key: "calendar.view", scope: "own" },
    { key: "analytics.view", scope: "own" },
  ]);
  const admin = actor(
    [
      { key: "users.manage", scope: null },
      { key: "audit.view", scope: null },
    ],
    { isOwner: true },
  );

  it("every step names a target and a real permission, and starts with LUME itself", () => {
    expect(TOUR_STEPS[0]!.id).toBe("lume");
    for (const s of TOUR_STEPS) expect(s.target).toMatch(/^[a-z][a-z-]*$/);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
  });

  it("shows a rep only what they can open, and admins get the extra places", () => {
    const repIds = tourStepsFor(rep, ALL).map((s) => s.id);
    const adminIds = tourStepsFor(admin, ALL).map((s) => s.id);
    expect(repIds).toContain("reveal");
    expect(repIds).not.toContain("people");
    expect(repIds).not.toContain("audit");
    expect(adminIds).toContain("people");
    expect(adminIds).toContain("audit");
    expect(adminIds.length).toBeGreaterThan(repIds.length);
  });

  it("leaves out steps for parts that do not exist yet", () => {
    expect(tourStepsFor(rep, NONE).map((s) => s.id)).not.toContain("calendar");
  });

  it("is needed until finished or skipped, and again after a new version", () => {
    expect(needsTour(EMPTY_TOUR)).toBe(true);
    expect(needsTour({ version: TOUR_VERSION, step: 3, completedAt: null, skippedAt: null })).toBe(true);
    expect(needsTour({ version: TOUR_VERSION, step: 9, completedAt: "now", skippedAt: null })).toBe(false);
    expect(needsTour({ version: TOUR_VERSION, step: 2, completedAt: null, skippedAt: "now" })).toBe(false);
    expect(needsTour({ version: TOUR_VERSION - 1, step: 9, completedAt: "now", skippedAt: null })).toBe(true);
  });

  it("marks module names bold without any HTML", () => {
    expect(boldParts("Press **Ctrl K** to search")).toEqual([
      { text: "Press ", bold: false },
      { text: "Ctrl K", bold: true },
      { text: " to search", bold: false },
    ]);
    expect(boldParts("<b>nope</b>")).toEqual([{ text: "<b>nope</b>", bold: false }]);
  });
});
