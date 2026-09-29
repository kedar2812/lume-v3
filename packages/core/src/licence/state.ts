import { z } from "zod";

/** Worst last: a state never improves by combining (spec §3.3). */
export const LICENCE_STATES = ["active", "grace", "read_only", "suspended"] as const;
export type LicenceStateName = (typeof LICENCE_STATES)[number];
export type LicenceType = "subscription" | "perpetual" | "trial";

export const licenceNoticeSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal("payment_due"),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    note: z.string().max(1000),
  })
  .strict();
export type LicenceNotice = z.infer<typeof licenceNoticeSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** What the licence server signs (spec §2). Anything else, however well signed, isn't a licence. */
export const licencePayloadSchema = z
  .object({
    v: z.literal(1),
    kid: z.string().min(1).max(32),
    instanceId: z.string().min(1).max(64),
    state: z.enum(LICENCE_STATES),
    licenseType: z.enum(["subscription", "perpetual", "trial"]),
    issuedAt: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    paidUntil: isoDate.nullable(),
    trialEndsAt: isoDate.nullable(),
    reason: z.string().min(1).max(32),
    notice: licenceNoticeSchema.nullable(),
  })
  .strict();
export type LicencePayload = z.infer<typeof licencePayloadSchema>;

/** The licence as the instance acts on it, and as people see it. */
export type LicenceView = {
  state: LicenceStateName;
  /**
   * Why: the server's own reason (`paid`, `overdue`, `trial`, `trial_ended`, `perpetual`, `suspended`), or
   * the instance's (`unreachable`, `expired`, `clock`, `not_checked`, `dev`).
   */
  reason: string;
  /** When grace turns read-only, if it's in grace and LUME knows. */
  graceEndsAt: string | null;
  licenseType: LicenceType | null;
  paidUntil: string | null;
  trialEndsAt: string | null;
  notice: LicenceNotice | null;
  /** The last time the licence server answered. */
  checkedAt: string | null;
  /** A development build's licence: always active. */
  dev: boolean;
};

const H = 3_600_000;
const D = 24 * H;
/** The instance's clock may run this far behind the server's before it counts as set back. */
const CLOCK_SLACK = 5 * 60_000;
const rank = (s: LicenceStateName) => LICENCE_STATES.indexOf(s);

type Candidate = { state: LicenceStateName; reason: string; graceEndsAt: string | null };

/**
 * The state an instance is in (spec §3.3): the worst of the token's own state, a clock set back before the
 * token was issued, the token expired, and how long the licence server has been out of reach — measured
 * from the last answer, or from first boot for an install that has never had one.
 */
export function licenceState(o: {
  payload: LicencePayload | null;
  lastSuccessAt: Date | null;
  firstBootAt: Date;
  now: Date;
  dev: boolean;
}): LicenceView {
  const p = o.payload;
  const base = {
    licenseType: p?.licenseType ?? null,
    paidUntil: p?.paidUntil ?? null,
    trialEndsAt: p?.trialEndsAt ?? null,
    notice: p?.notice ?? null,
    checkedAt: o.lastSuccessAt ? o.lastSuccessAt.toISOString() : null,
    dev: o.dev,
  };
  if (o.dev) return { ...base, state: "active", reason: "dev", graceEndsAt: null };

  const now = o.now.getTime();
  const since = (o.lastSuccessAt ?? o.firstBootAt).getTime();
  const graceEnds = new Date(since + 7 * D).toISOString();
  const found: Candidate[] = [];
  if (p) {
    found.push({
      state: p.state,
      reason: p.reason,
      graceEndsAt: p.state === "grace" ? overdueEnds(p) : null,
    });
    if (now < Date.parse(p.issuedAt) - CLOCK_SLACK)
      found.push({ state: "read_only", reason: "clock", graceEndsAt: null });
    if (now >= Date.parse(p.validUntil))
      found.push({ state: "read_only", reason: "expired", graceEndsAt: null });
    if (now - since >= 7 * D) found.push({ state: "read_only", reason: "unreachable", graceEndsAt: null });
    else if (now - since >= D) found.push({ state: "grace", reason: "unreachable", graceEndsAt: graceEnds });
  } else if (now - since >= 7 * D)
    found.push({ state: "read_only", reason: "not_checked", graceEndsAt: null });
  else found.push({ state: "grace", reason: "not_checked", graceEndsAt: graceEnds });

  // The worst wins; between equals, the first found (the server's own word) stands.
  const worst = found.reduce((a, b) => (rank(b.state) > rank(a.state) ? b : a));
  return { ...base, ...worst };
}

/** A late payment's grace ends when the 7th day after `paidUntil` does (the server's own rule, spec §4.3). */
function overdueEnds(p: LicencePayload): string | null {
  if (p.reason !== "overdue" || !p.paidUntil) return null;
  return new Date(Date.parse(`${p.paidUntil}T00:00:00Z`) + 8 * D).toISOString();
}
