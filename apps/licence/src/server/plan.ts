import { PLAN_MODULES, PLAN_V1_MODULES, type PlanClaim, type PlanModule } from "@lume/core";

type Row = {
  places: number | null;
  modules: Record<string, boolean> | null;
  ai_reads_hourly?: number | null;
  ai_reads_weekly?: number | null;
};

/**
 * A client's plan as it's signed (spec 2026-10-17 control §1): its places (null: no limit) and every module, in it
 * unless the owner left it out. LUME AI, WhatsApp and the AI limits (spec 2026-10-18 §2.2) only for a LUME that
 * accepts plan2 (`v2`): an older one refuses keys it doesn't know.
 */
export function planOf(l: Row, o: { v2: boolean }): PlanClaim {
  const m = l.modules ?? {};
  const keys = o.v2 ? PLAN_MODULES : PLAN_V1_MODULES;
  const modules = Object.fromEntries(keys.map((k) => [k, m[k] !== false])) as PlanClaim["modules"];
  if (!o.v2) return { places: l.places, modules };
  return {
    places: l.places,
    modules,
    aiReadsHourly: l.ai_reads_hourly ?? null,
    aiReadsWeekly: l.ai_reads_weekly ?? null,
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
