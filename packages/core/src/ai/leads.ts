import type { AiTask } from "./tasks";

/**
 * AI leads (owner's spec 2026-11-12): LUME AI's allowance is counted in leads a calendar month on the business's clock,
 * not in actions. A lead counts once a month, the first time Autopilot starts on it or it gets one of these. The cheap
 * reads (choosing a template, reading a reply's meaning, drafting a template) never count and never use it up.
 */
export const AI_COUNTED_TASKS = [
  "autopilot_reply",
  "next_step",
  "catch_up",
] as const satisfies readonly AiTask[];
export type AiCountedTask = (typeof AI_COUNTED_TASKS)[number];
export const isCountedTask = (t: AiTask): t is AiCountedTask =>
  (AI_COUNTED_TASKS as readonly AiTask[]).includes(t);

/** Counted actions a lead may have a month: after this many it goes to a person until the 1st. */
export const AI_LEAD_ACTIONS_MAX = 20;
/** Admins hear at this share of the month's AI leads, and at all of them. */
export const AI_LEADS_NOTICE_SHARE = 0.8;
/** A top-up is this many AI leads (or several packs), for its month only. */
export const AI_TOP_UP_PACK = 100;

/** The plans' AI leads a month (owner 2026-11-12): set on the licence, and any other number may be typed. */
export const AI_LEAD_TIERS = [
  { key: "base", name: "Base", leads: 0 },
  { key: "pro", name: "Pro", leads: 1000 },
  { key: "max", name: "Max", leads: 3000 },
  { key: "enterprise", name: "Enterprise", leads: 10_000 },
] as const;

/**
 * The hidden safety net when the owner set no monthly number: this many actions a month for each AI lead, and never
 * fewer than the floor. Well above use: an average lead takes about 7, and a lead may take at most 20 counted ones.
 */
export const AI_SAFETY_PER_LEAD = 30;
export const AI_SAFETY_FLOOR = 1000;
export const aiSafetyFor = (leads: number): number => Math.max(AI_SAFETY_FLOOR, leads * AI_SAFETY_PER_LEAD);

/** Actions an AI lead takes in an average month (measured 2026-11-12): what a LUME from before AI leads is signed. */
export const AI_CALLS_PER_LEAD = 7;
export const aiCallsForOlder = (leads: number | null): number | null =>
  leads === null ? null : leads * AI_CALLS_PER_LEAD;
