import { PLAN_MODULES, type PlanClaim, type PlanModule } from "@lume/core";

/**
 * A client's plan as it's signed (spec 2026-10-17 control §1): its places (null: no limit) and every module, in it
 * unless the owner left it out.
 */
export function planOf(l: { places: number | null; modules: Record<string, boolean> | null }): PlanClaim {
  const m = l.modules ?? {};
  const modules = Object.fromEntries(PLAN_MODULES.map((k) => [k, m[k] !== false])) as Record<
    PlanModule,
    boolean
  >;
  return { places: l.places, modules };
}

/** "Plan: 5 places; Calendly not included" — a plan change as the client's history says it. */
export const MODULE_WORDS: Record<PlanModule, string> = {
  googleSheets: "Google Sheets",
  webhooks: "Webhooks",
  googleCalendar: "Google Calendar",
  calendly: "Calendly",
};
