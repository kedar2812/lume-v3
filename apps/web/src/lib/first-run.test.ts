import { describe, expect, it } from "vitest";
import { firstRunStop } from "./first-run";

const flags = (
  f: Partial<Record<"needsAgreement" | "needsOnboarding" | "needsTwoFactorEnrolment", boolean>>,
) => ({
  needsAgreement: false,
  needsOnboarding: false,
  needsTwoFactorEnrolment: false,
  needsTour: false,
  ...f,
});

describe("firstRunStop", () => {
  it("puts the agreement before everything, then onboarding (and any required enrolment), then the app", () => {
    expect(
      firstRunStop(flags({ needsAgreement: true, needsOnboarding: true, needsTwoFactorEnrolment: true })),
    ).toBe("/agree");
    expect(firstRunStop(flags({ needsOnboarding: true }))).toBe("/welcome");
    expect(firstRunStop(flags({ needsTwoFactorEnrolment: true }))).toBe("/welcome");
    expect(firstRunStop(flags({}))).toBeNull();
  });

  it("onboarding lets Google's and WhatsApp's hand-back pages finish, so a connect started from it can (2026-10-31)", () => {
    // A client's onboarding: Calendar's Connect came back to /calendar/connected, which sent her to /welcome, unfinished.
    const onboarding = flags({ needsOnboarding: true });
    for (const path of [
      "/calendar/connected",
      "/settings/integrations/connected",
      "/settings/integrations/whatsapp/connected",
    ])
      expect(firstRunStop(onboarding, false, path), path).toBeNull();
    for (const path of ["/calendar", "/today", "/calendar/connected/x", "/calendar/connectedx", null])
      expect(firstRunStop(onboarding, false, path), String(path)).toBe("/welcome");
    // Never past the agreement or a required two-step.
    expect(
      firstRunStop(flags({ needsAgreement: true, needsOnboarding: true }), false, "/calendar/connected"),
    ).toBe("/agree");
    expect(firstRunStop(flags({ needsTwoFactorEnrolment: true }), false, "/calendar/connected")).toBe(
      "/welcome",
    );
  });

  it("while LUME is locked, onboarding waits: the agreement and a required two-step still come first", () => {
    expect(firstRunStop(flags({ needsOnboarding: true }), true)).toBeNull();
    expect(firstRunStop(flags({ needsOnboarding: true, needsTwoFactorEnrolment: true }), true)).toBe(
      "/welcome",
    );
    expect(firstRunStop(flags({ needsAgreement: true }), true)).toBe("/agree");
  });
});
