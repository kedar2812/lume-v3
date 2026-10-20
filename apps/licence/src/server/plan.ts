import { PLAN_MODULES, PLAN_V1_MODULES, type PlanClaim, type PlanModule } from "@lume/core";

type Row = {
  places: number | null;
  modules: Record<string, boolean> | null;
  ai_reads_hourly?: number | null;
  ai_reads_weekly?: number | null;
  paid_sends_monthly?: number | null;
  ai_calls_monthly?: number | null;
};

/**
 * A client's plan as it's signed (spec 2026-10-17 control §1): its places (null: no limit) and every module, in it
 * unless the owner left it out. LUME AI, WhatsApp and the AI limits (spec 2026-10-18 §2.2) only for a LUME that
 * accepts plan2 (`v2`): an older one refuses keys it doesn't know.
 */
export function planOf(
  l: Row,
  o: { v2: boolean; v3?: boolean; v4?: boolean; topUps?: { month: string; calls: number }[] },
): PlanClaim {
  const m = l.modules ?? {};
  const keys = o.v2 ? PLAN_MODULES : PLAN_V1_MODULES;
  const modules = Object.fromEntries(keys.map((k) => [k, m[k] !== false])) as PlanClaim["modules"];
  if (!o.v2) return { places: l.places, modules };
  return {
    places: l.places,
    modules,
    aiReadsHourly: l.ai_reads_hourly ?? null,
    aiReadsWeekly: l.ai_reads_weekly ?? null,
    // Paid WhatsApp messages a month (W3b-2) only for a LUME that accepts plan3.
    ...(o.v3 ? { paidSendsMonthly: l.paid_sends_monthly ?? null } : {}),
    // LUME AI a month and its top-ups (Autopilot spec 2026-10-19 §4) only for a LUME that accepts plan4.
    ...(o.v4 ? { aiCallsMonthly: l.ai_calls_monthly ?? null, aiTopUps: o.topUps ?? [] } : {}),
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

/**
 * A client's top-ups for the month before, this one and the next (UTC; its own clock may be a day either side), one
 * entry a month with its calls added up: what a plan4 check-in signs.
 */
export async function topUpsAround(
  db: { query: (sql: string, args: unknown[]) => Promise<{ rows: { month: string; calls: number }[] }> },
  clientId: string,
  now: Date,
): Promise<{ month: string; calls: number }[]> {
  const month = (d: number) => {
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + d, 1));
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const { rows } = await db.query(
    `SELECT month, sum(calls)::int AS calls FROM ai_topups
      WHERE client_id = $1 AND month IN ($2, $3, $4) GROUP BY month ORDER BY month`,
    [clientId, month(-1), month(0), month(1)],
  );
  return rows.map((r) => ({ month: r.month, calls: Math.min(10_000_000, Number(r.calls)) }));
}
