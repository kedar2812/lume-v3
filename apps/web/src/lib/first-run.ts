import type { Session } from "@/server/session";

/**
 * Where someone must go before the app: the licence agreement, terms and privacy policy first, then
 * onboarding (with any required two-step enrolment), or nowhere (null) when both are done.
 */
export function firstRunStop(flags: Session["flags"]): "/agree" | "/welcome" | null {
  if (flags.needsAgreement) return "/agree";
  if (flags.needsOnboarding || flags.needsTwoFactorEnrolment) return "/welcome";
  return null;
}
