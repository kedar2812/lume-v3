import { TEMPLATE_CATEGORIES, type TemplateCategory } from "@lume/core/shared";
import type { TemplateView } from "./client";

/** The context's kind first (a follow-up suggests Follow-up; a lost lead, Re-engagement), then the rest. */
export function ordered(templates: TemplateView[], suggest?: TemplateCategory): TemplateView[] {
  const kinds = TEMPLATE_CATEGORIES.map((c) => c.key);
  const rank = (c: TemplateCategory) => (c === suggest ? -1 : kinds.indexOf(c));
  return templates
    .filter((t) => t.usable)
    .map((t, i) => ({ t, i }))
    .sort((x, y) => rank(x.t.category) - rank(y.t.category) || x.i - y.i)
    .map((x) => x.t);
}

/**
 * The kind of message a saved view's leads want (4C): lost leads, Re-engagement; gone quiet or overdue,
 * Follow-up; just arrived, First touch. Filters are the view's own strings (4B).
 */
export function suggestFor(
  filters: Record<string, string>,
  lostStageIds: string[],
): TemplateCategory | undefined {
  const stages = filters.stageId?.split(",") ?? [];
  if (
    filters.lostDaysAgo ||
    filters.lostReasonId ||
    (stages.length && stages.every((id) => lostStageIds.includes(id)))
  )
    return "re_engagement";
  if (filters.noReplyDays || filters.followUpOverdue === "true") return "follow_up";
  if (filters.createdDays) return "first_touch";
  return undefined;
}
