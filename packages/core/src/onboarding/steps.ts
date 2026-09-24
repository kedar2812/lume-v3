import type { PermissionKey } from "../rbac/catalog";
import { can, requiresTwoFactor, type Actor } from "../rbac/engine";

/** Which integrations this build actually has (the API owns the values; see apps/api/src/capabilities.ts). */
export type Capabilities = { sheets: boolean; calendar: boolean };

export type OnboardingStepId =
  "welcome" | "you" | "secure" | "look" | "day" | "alerts" | "team" | "pipeline" | "connect" | "done";

export type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  group: "intro" | "you" | "workspace" | "end";
  /** A required step cannot be skipped and blocks the ones after it. */
  required: boolean;
  permission: PermissionKey | null;
  /** Only for people whose roles require two-step sign-in and who haven't enrolled. */
  needsEnrolment?: true;
  /** Only when that integration exists in this build. */
  needsCapability?: "sheets" | "calendar";
};

/**
 * Spec §4.1. Name first, then the required two-step enrolment for admins, then the rest. Order is fixed
 * here so the API and the web app show exactly the same flow.
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { id: "welcome", title: "Welcome", group: "intro", required: false, permission: null },
  { id: "you", title: "You", group: "you", required: false, permission: null },
  {
    id: "secure",
    title: "Secure account",
    group: "you",
    required: true,
    permission: null,
    needsEnrolment: true,
  },
  { id: "look", title: "Look", group: "you", required: false, permission: null },
  { id: "day", title: "Your day", group: "you", required: false, permission: null },
  { id: "alerts", title: "Alerts", group: "you", required: false, permission: null },
  { id: "team", title: "Your team", group: "workspace", required: false, permission: "users.manage" },
  { id: "pipeline", title: "Pipeline", group: "workspace", required: false, permission: "pipelines.manage" },
  { id: "connect", title: "Connect", group: "workspace", required: false, permission: null },
  { id: "done", title: "All set", group: "end", required: false, permission: null },
];

export type OnboardingContext = { actor: Actor; twoFactorEnabled: boolean; capabilities: Capabilities };

export function onboardingStepsFor({
  actor,
  twoFactorEnabled,
  capabilities,
}: OnboardingContext): OnboardingStep[] {
  const hasConnect =
    (capabilities.calendar && (actor.isOwner || can(actor, "calendar.connect"))) ||
    (capabilities.sheets && (actor.isOwner || can(actor, "leads.import")));
  return ONBOARDING_STEPS.filter((s) => {
    if (s.needsEnrolment) return requiresTwoFactor(actor) && !twoFactorEnabled;
    if (s.id === "connect") return hasConnect;
    return s.permission === null || can(actor, s.permission);
  });
}

export type OnboardingState = {
  step: OnboardingStepId | null;
  skipped: OnboardingStepId[];
  completedAt: string | null;
};
export const EMPTY_ONBOARDING: OnboardingState = { step: null, skipped: [], completedAt: null };
export const needsOnboarding = (state: OnboardingState): boolean => state.completedAt === null;
