import type { SessionUser } from "@/server/session";

/** The person's day runs on this zone: the session's, else their own, else this browser's (never a guess at UTC). */
export function zoneOf(u: Pick<SessionUser, "zone" | "timezone">): string {
  return u.zone ?? u.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}
