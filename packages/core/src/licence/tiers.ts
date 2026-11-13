import type { AutopilotAction } from "../ai/profile";

/**
 * Plans and pricing (November 2026): Base is the full LUME without AI; Pro adds LUME AI (Autopilot first messages and
 * follow-ups, suggested next steps, catch-ups); Max adds Autopilot replies and "Ask me" reply approval; Enterprise is
 * Max shaped around the team. The tier rides in the signed plan; no tier means no tier limits.
 */
export const PLAN_TIERS = ["base", "pro", "max", "enterprise"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

const NAMES: Record<PlanTier, string> = { base: "Base", pro: "Pro", max: "Max", enterprise: "Enterprise" };
export const tierName = (t: PlanTier): string => NAMES[t];

/** What a tier can switch on: `ai` is all of LUME AI; `ai_replies` is Autopilot answering leads, and Ask me for it. */
export type TierFeature = "ai" | "ai_replies";
const FIRST_TIER: Record<TierFeature, PlanTier> = { ai: "pro", ai_replies: "max" };
const rank = (t: PlanTier) => PLAN_TIERS.indexOf(t);

type WithTier = { tier?: PlanTier | null } | null | undefined;

/** Whether this plan's tier has the feature. No plan, or a plan without a tier: everything, as before tiers. */
export function tierAllows(plan: WithTier, f: TierFeature): boolean {
  const t = plan?.tier;
  return !t || rank(t) >= rank(FIRST_TIER[f]);
}
/** The lowest tier with the feature: the one to upgrade to. */
export const tierFor = (f: TierFeature): PlanTier => FIRST_TIER[f];
/** The tier after this one, or null from the top. */
export const nextTier = (t: PlanTier): PlanTier | null => PLAN_TIERS[rank(t) + 1] ?? null;
/** "Max and Enterprise", "Pro, Max and Enterprise": every tier with the feature, in words. */
export function tiersWith(f: TierFeature): string {
  const names = PLAN_TIERS.slice(rank(FIRST_TIER[f])).map(tierName);
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What LUME AI only ever does inside its reply to a lead (guardReply): locked on a tier without replies. */
export const REPLY_ACTIONS: readonly AutopilotAction[] = [
  "replies",
  "send_files",
  "book_meetings",
  "move_stages",
  "set_follow_ups",
  "fill_fields",
  "answer_prices",
  "mark_lost",
];
/** Whether this plan's tier keeps LUME AI from answering leads (Pro). */
export const repliesLocked = (plan: WithTier): boolean =>
  tierAllows(plan, "ai") && !tierAllows(plan, "ai_replies");

/** Each tier's own lines (what it adds to the one before), as Plans and pricing says them. */
export const TIER_LINES: Record<PlanTier, readonly string[]> = {
  base: [
    "Unlimited seats",
    "One lead list, with imports",
    "Today screens and Team board",
    "WhatsApp inbox inside LUME",
    "Sheets, Calendar, Calendly and ManyChat",
    "Roles, traceable exports and analytics",
  ],
  pro: [
    "LUME AI, with 1,000 AI leads a month",
    "Autopilot first messages and follow-ups",
    "Suggested next steps and catch-ups",
  ],
  max: [
    "3,000 AI leads a month",
    "Autopilot replies to your leads",
    "“Ask me” approval for replies",
    "Priority support",
  ],
  enterprise: ["10,000 AI leads a month", "Custom integrations", "Team training"],
};

/**
 * What an admin can do when the month's AI leads run low (Plans and pricing: packs of 100 on Pro and Max, more AI leads
 * on Enterprise): a top-up, or the next tier with its own AI leads. Null: no tier, the words stay as they were.
 */
export function moreLeadsLine(tier: PlanTier | null | undefined): string | null {
  if (!tier || tier === "base") return null;
  const next = nextTier(tier);
  if (!next) return "Ask LUME for more AI leads from LUME AI's ring.";
  const leads = TIER_LINES[next][0]!.replace(" a month", "");
  return `Ask for 100 more from LUME AI's ring, or about ${tierName(next)}: ${leads} a month.`;
}
