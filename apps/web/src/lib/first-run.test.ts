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

  it("while LUME is locked, onboarding waits: the agreement and a required two-step still come first", () => {
    expect(firstRunStop(flags({ needsOnboarding: true }), true)).toBeNull();
    expect(firstRunStop(flags({ needsOnboarding: true, needsTwoFactorEnrolment: true }), true)).toBe(
      "/welcome",
    );
    expect(firstRunStop(flags({ needsAgreement: true }), true)).toBe("/agree");
  });
});
