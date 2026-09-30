import type { Session } from "@/server/session";

/**
 * Where someone must go before the app: the licence agreement, terms and privacy policy first, then
 * onboarding (with any required two-step enrolment), or nowhere (null) when both are done. While LUME is
 * locked (read-only or paused) onboarding waits, so nobody is kept from the app, and its export, by steps
 * that can't be saved; the agreement and a required two-step still come first.
 */
export function firstRunStop(flags: Session["flags"], locked = false): "/agree" | "/welcome" | null {
  if (flags.needsAgreement) return "/agree";
  if (flags.needsTwoFactorEnrolment || (flags.needsOnboarding && !locked)) return "/welcome";
  return null;
}

/** Whether the licence keeps LUME from being changed (the API refuses writes). */
export const isLocked = (s: Pick<Session, "licence">) =>
  s.licence.state === "read_only" || s.licence.state === "suspended";
