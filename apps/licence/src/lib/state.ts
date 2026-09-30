import type { LicenceStateName, LicenceType } from "@lume/core/shared";

const DAY = 86_400_000;
/** A late subscription is grace for this many days after it was paid until, then read-only. */
export const GRACE_DAYS = 7;

/** A UTC calendar day, "YYYY-MM-DD" (the instance counts grace in UTC days too). */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string =>
  utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));
/** Whole days from `a` to `b` (both "YYYY-MM-DD"). */
export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export type LicenceFacts = {
  type: LicenceType;
  paidUntil: string | null;
  trialEnds: string | null;
  suspended?: boolean;
  decommissioned?: boolean;
};

/**
 * The state the licence server signs (spec §4.3): suspended or decommissioned beats everything; perpetual is
 * active; a trial is active through its last day; a subscription is active while paid until today or later,
 * grace for 7 days after, then read-only. A licence missing the date its type needs is read-only, not free.
 */
export function serverState(l: LicenceFacts, now: Date): { state: LicenceStateName; reason: string } {
  if (l.suspended || l.decommissioned) return { state: "suspended", reason: "suspended" };
  if (l.type === "perpetual") return { state: "active", reason: "perpetual" };
  const today = utcDay(now);
  if (l.type === "trial") {
    return l.trialEnds && today <= l.trialEnds
      ? { state: "active", reason: "trial" }
      : { state: "read_only", reason: "trial_ended" };
  }
  if (!l.paidUntil) return { state: "read_only", reason: "overdue" };
  const late = daysBetween(l.paidUntil, today);
  if (late <= 0) return { state: "active", reason: "paid" };
  if (late <= GRACE_DAYS) return { state: "grace", reason: "overdue" };
  return { state: "read_only", reason: "overdue" };
}
