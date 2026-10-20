import { z } from "zod";

/**
 * Fleet (spec 2026-10-16 fleet §1): what a LUME says about its own health with each check-in, and what the licence
 * server may tell it. Counts, sizes, times and these fixed keys only — never a lead, a person or a source's name.
 */
export const HEALTH_PROBLEMS = [
  "reminders_late",
  "sweeper_stopped",
  "jobs_unreadable",
  "jobs_failed",
  "digest_failing",
  "source",
  "restore_test",
] as const;
export type HealthProblem = (typeof HEALTH_PROBLEMS)[number];

/** The modules a plan can leave out (spec 2026-10-17 control §1): LUME's optional ones, by these keys only. */
export const PLAN_MODULES = [
  "googleSheets",
  "webhooks",
  "googleCalendar",
  "calendly",
  "ai",
  "whatsapp",
] as const;
/** The modules every licence server since Control signs; `ai` and `whatsapp` only go to a LUME that accepts plan2. */
export const PLAN_V1_MODULES = ["googleSheets", "webhooks", "googleCalendar", "calendly"] as const;
export type PlanModule = (typeof PLAN_MODULES)[number];

const count = z.number().int().min(0).max(1_000_000_000);
export const fleetHealthSchema = z
  .object({
    uptimeS: count,
    dbBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    diskFreePct: z.number().int().min(0).max(100).nullable(),
    errors24h: count,
    queue: z.object({ waiting: count, retrying: count, failed24h: count }).strict(),
    remindersLate: count,
    restoreTest: z.object({ at: z.iso.datetime(), ok: z.boolean() }).strict().nullable(),
    problems: z.array(z.enum(HEALTH_PROBLEMS)).max(HEALTH_PROBLEMS.length),
    sourcesNeedingAttention: count,
    /** Which plan modules are switched on now (control §1), so the dashboard can warn before taking one away. */
    modulesOn: z.array(z.enum(PLAN_MODULES)).max(PLAN_MODULES.length).optional(),
  })
  .strict();
export type FleetHealth = z.infer<typeof fleetHealthSchema>;

const MAX_COUNT = 1_000_000_000;
const whole = (n: number, max = MAX_COUNT) =>
  Math.min(max, Math.max(0, Math.floor(Number.isFinite(n) ? n : 0)));

/** Health as it may travel: whole numbers within bounds, a percentage 0–100, each known problem key once. */
export function capHealth(h: FleetHealth): FleetHealth {
  const known = new Set<string>(HEALTH_PROBLEMS);
  return {
    uptimeS: whole(h.uptimeS),
    dbBytes: whole(h.dbBytes, Number.MAX_SAFE_INTEGER),
    diskFreePct: h.diskFreePct === null ? null : whole(h.diskFreePct, 100),
    errors24h: whole(h.errors24h),
    queue: {
      waiting: whole(h.queue.waiting),
      retrying: whole(h.queue.retrying),
      failed24h: whole(h.queue.failed24h),
    },
    remindersLate: whole(h.remindersLate),
    restoreTest: h.restoreTest ? { at: h.restoreTest.at, ok: !!h.restoreTest.ok } : null,
    problems: [...new Set(h.problems)].filter((p): p is HealthProblem => known.has(p)),
    sourcesNeedingAttention: whole(h.sourcesNeedingAttention),
    ...(h.modulesOn ? { modulesOn: PLAN_MODULES.filter((m) => h.modulesOn!.includes(m)) } : {}),
  };
}

/** One announcement as the licence server signs it (spec fleet §2.3): plain text, at most 3 in an answer. */
export const announcementClaimSchema = z
  .object({
    id: z.uuid(),
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(600),
    kind: z.enum(["update", "maintenance"]),
    audience: z.enum(["everyone", "admins"]),
    windowStart: z.iso.datetime().nullable(),
    windowEnd: z.iso.datetime().nullable(),
    endsAt: z.iso.datetime(),
  })
  .strict();
export type AnnouncementClaim = z.infer<typeof announcementClaimSchema>;
/**
 * A client's plan as the licence server signs it (spec 2026-10-17 control §1): how many places, and which modules are
 * in it. Kept by the client's LUME; no plan in an answer means no limits.
 */
export const planClaimSchema = z
  .object({
    places: z.number().int().min(1).max(10_000).nullable(),
    modules: z
      .object({
        googleSheets: z.boolean(),
        webhooks: z.boolean(),
        googleCalendar: z.boolean(),
        calendly: z.boolean(),
        // LUME AI and WhatsApp (spec 2026-10-18 §2.2): absent from an older licence server's answer = included.
        ai: z.boolean().optional(),
        whatsapp: z.boolean().optional(),
      })
      .strict(),
    /** LUME AI's limits (§2.2): reads in a rolling hour, and in a week from Monday 00:00. Absent or null: none. */
    aiReadsHourly: z.number().int().min(1).max(100_000).nullable().optional(),
    aiReadsWeekly: z.number().int().min(1).max(1_000_000).nullable().optional(),
    /**
     * Paid WhatsApp messages a month (W3b-2; owner 2026-10-19: usage is monthly): templates WhatsApp charges for, on the
     * business's clock. Absent or null: none. Only for a LUME that accepts plan3.
     */
    paidSendsMonthly: z.number().int().min(1).max(10_000_000).nullable().optional(),
    /**
     * LUME AI a month (Autopilot spec 2026-10-19 §4; owner: monthly, and generous): every AI call, on the business's
     * clock, replacing the weekly reads. Null: none. Absent: an older licence server's answer, and the week stays.
     * Only for a LUME that accepts plan4.
     */
    aiCallsMonthly: z.number().int().min(1).max(10_000_000).nullable().optional(),
    /** Top-ups the owner added (§4: on an admin's request), by month "YYYY-MM". */
    aiTopUps: z
      .array(
        z
          .object({
            month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
            calls: z.number().int().min(1).max(10_000_000),
          })
          .strict(),
      )
      .max(12)
      .optional(),
  })
  .strict();
export type PlanClaim = z.infer<typeof planClaimSchema>;
/** Whether this LUME's licence counts LUME AI by the month (a plan4 answer), rather than the week. */
export const usesMonthly = (plan: PlanClaim | null | undefined): boolean =>
  plan?.aiCallsMonthly !== undefined;
/** LUME AI's allowance for a month ("YYYY-MM"): the plan's, plus that month's top-ups. Null: no limit. */
export function aiAllowance(plan: PlanClaim | null | undefined, month: string): number | null {
  if (plan?.aiCallsMonthly === undefined || plan.aiCallsMonthly === null) return null;
  return (
    plan.aiCallsMonthly +
    (plan.aiTopUps ?? []).filter((t) => t.month === month).reduce((a, t) => a + t.calls, 0)
  );
}
/** Whether a plan includes a module: everything does with no plan, and a module the plan doesn't name is in it. */
export const moduleIncluded = (plan: PlanClaim | null | undefined, key: PlanModule): boolean =>
  plan?.modules[key] !== false;
/** What a LUME from this release can keep, sent with its check-in: the licence server signs those claims only then. */
export const ACCEPTS = ["announcements", "plan", "plan2", "plan3", "plan4"] as const;
