import type { Session } from "@/server/session";

/**
 * Where a connect started from onboarding comes back to (Google's Calendar and Sheets, WhatsApp's signup): these
 * finish it, then return to where it began. Onboarding lets them through (2026-10-31: Calendar's Connect came back
 * here and was sent to /welcome unfinished); nothing else, and never past the agreement or a required two-step.
 */
const HAND_BACKS = new Set([
  "/calendar/connected",
  "/settings/integrations/connected",
  "/settings/integrations/whatsapp/connected",
]);

/**
 * Where someone must go before the app: the licence agreement, terms and privacy policy first, then
 * onboarding (with any required two-step enrolment), or nowhere (null) when both are done. While LUME is
 * locked (read-only or paused) onboarding waits, so nobody is kept from the app, and its export, by steps
 * that can't be saved; the agreement and a required two-step still come first. `path`, the page asked for:
 * a connect's hand-back finishes during onboarding.
 */
export function firstRunStop(
  flags: Session["flags"],
  locked = false,
  path: string | null = null,
): "/agree" | "/welcome" | null {
  if (flags.needsAgreement) return "/agree";
  if (flags.needsTwoFactorEnrolment) return "/welcome";
  if (flags.needsOnboarding && !locked && !(path && HAND_BACKS.has(path))) return "/welcome";
  return null;
}

/** Whether the licence keeps LUME from being changed (the API refuses writes). */
export const isLocked = (s: Pick<Session, "licence">) =>
  s.licence.state === "read_only" || s.licence.state === "suspended";
