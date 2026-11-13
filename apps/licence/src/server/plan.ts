import {
  aiCallsForOlder,
  PLAN_MODULES,
  PLAN_V1_MODULES,
  type PlanClaim,
  type PlanModule,
  type PlanTier,
} from "@lume/core";

type Row = {
  places: number | null;
  modules: Record<string, boolean> | null;
  ai_reads_hourly?: number | null;
  ai_reads_weekly?: number | null;
  paid_sends_monthly?: number | null;
  ai_calls_monthly?: number | null;
  ai_leads_monthly?: number | null;
  tier?: PlanTier | null;
};
/** Top-ups around this month, one entry a month: calls (added before AI leads) and AI leads, each added up. */
export type TopUpsNow = { month: string; calls: number; leads: number }[];

/**
 * A client's plan as it's signed (spec 2026-10-17 control §1): its places (null: no limit) and every module, in it
 * unless the owner left it out. LUME AI, WhatsApp and the AI limits (spec 2026-10-18 §2.2) only for a LUME that
 * accepts plan2 (`v2`): an older one refuses keys it doesn't know.
 *
 * AI leads (2026-11-12): a LUME that accepts plan5 gets its AI leads a month and this month's packs, beside the
 * owner's own monthly number as its hidden safety net (null: the LUME sizes it). An older one (plan4) still counts
 * actions: the owner's number, else 7 for each AI lead and each pack's lead; Base (0) is LUME AI off for it, as it can't
 * be told none.
 */
export function planOf(
  l: Row,
  o: { v2: boolean; v3?: boolean; v4?: boolean; v5?: boolean; v6?: boolean; topUps?: TopUpsNow },
): PlanClaim {
  const m = l.modules ?? {};
  const keys = o.v2 ? PLAN_MODULES : PLAN_V1_MODULES;
  const modules = Object.fromEntries(keys.map((k) => [k, m[k] !== false])) as PlanClaim["modules"];
  if (!o.v2) return { places: l.places, modules };
  const leads = l.ai_leads_monthly ?? null;
  const own = l.ai_calls_monthly ?? null;
  const topUps = o.topUps ?? [];
  const older = !o.v5;
  if (older && leads === 0 && own === null) modules.ai = false;
  // Base (Plans and pricing, November 2026) is LUME without AI: a LUME that can't be told its tier has LUME AI off.
  if (!o.v6 && l.tier === "base") modules.ai = false;
  const calls = o.v5
    ? topUps.filter((t) => t.calls > 0).map((t) => ({ month: t.month, calls: t.calls }))
    : topUps
        .map((t) => ({
          month: t.month,
          calls: Math.min(10_000_000, t.calls + (aiCallsForOlder(t.leads) ?? 0)),
        }))
        .filter((t) => t.calls > 0);
  const monthly = o.v5 ? own : (own ?? (leads ? aiCallsForOlder(leads) : null));
  return {
    places: l.places,
    modules,
    aiReadsHourly: l.ai_reads_hourly ?? null,
    aiReadsWeekly: l.ai_reads_weekly ?? null,
    // Paid WhatsApp messages a month (W3b-2) only for a LUME that accepts plan3.
    ...(o.v3 ? { paidSendsMonthly: l.paid_sends_monthly ?? null } : {}),
    // LUME AI a month and its top-ups (Autopilot spec 2026-10-19 §4) only for a LUME that accepts plan4.
    ...(o.v4
      ? { aiCallsMonthly: monthly === null ? null : Math.min(10_000_000, monthly), aiTopUps: calls }
      : {}),
    // AI leads a month and this month's packs (2026-11-12) only for a LUME that accepts plan5.
    ...(o.v5
      ? {
          aiLeadsMonthly: leads,
          aiLeadTopUps: topUps.filter((t) => t.leads > 0).map((t) => ({ month: t.month, leads: t.leads })),
        }
      : {}),
    // The tier (November 2026) only for a LUME that accepts plan6: an older one refuses a key it doesn't know.
    ...(o.v6 ? { tier: l.tier ?? null } : {}),
  };
}

/** "Plan: 5 places; Calendly not included" — a plan change as the client's history says it. */
export const MODULE_WORDS: Record<PlanModule, string> = {
  googleSheets: "Google Sheets",
  webhooks: "Webhooks",
  googleCalendar: "Google Calendar",
  calendly: "Calendly",
  ai: "LUME AI",
  whatsapp: "WhatsApp",
};

/** "YYYY-MM" of the month `d` months from `now` (UTC). */
export const monthAround = (now: Date, d: number) => {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + d, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * A client's top-ups for the month before, this one and the next (UTC; its own clock may be a day either side), one
 * entry a month with its calls and its AI leads added up: what a plan4 or plan5 check-in signs. A month further
 * away isn't signed at all, so a top-up never carries past its month.
 */
export async function topUpsAround(
  db: {
    query: (
      sql: string,
      args: unknown[],
    ) => Promise<{ rows: { month: string; calls: number | string; leads: number | string }[] }>;
  },
  clientId: string,
  now: Date,
): Promise<TopUpsNow> {
  const { rows } = await db.query(
    `SELECT month, coalesce(sum(calls), 0)::bigint AS calls, coalesce(sum(leads), 0)::bigint AS leads FROM ai_topups
      WHERE client_id = $1 AND month IN ($2, $3, $4) GROUP BY month ORDER BY month`,
    [clientId, monthAround(now, -1), monthAround(now, 0), monthAround(now, 1)],
  );
  return rows.map((r) => ({
    month: r.month,
    calls: Math.min(10_000_000, Number(r.calls)),
    leads: Math.min(10_000_000, Number(r.leads)),
  }));
}
