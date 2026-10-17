import type { PlanModule } from "@lume/core/shared";
import type { PlanForPerson } from "@/lib/licence/client";
import s from "./plan.module.css";

/** Whether this LUME's plan includes a module (spec 2026-10-17 control §2.2): no plan means every module. */
export const inPlan = (plan: PlanForPerson | null, key: PlanModule) => plan?.modules[key] !== false;

/** What a module's card says when the plan leaves it out. */
export const NOT_IN_PLAN_NOTE = "Its settings are kept. Ask LUME’s team to add it to your plan.";

/** `flush` in a heading that already spaces what's beside its name (a flex row with a gap). */
export function NotInPlanPill({ flush = false }: { flush?: boolean }) {
  return (
    <span className={s.pill} data-flush={flush || undefined}>
      Not in this LUME’s plan
    </span>
  );
}
