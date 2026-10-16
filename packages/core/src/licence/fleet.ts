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
/** What a LUME from this release can show, sent with its check-in. */
export const ACCEPTS = ["announcements"] as const;
