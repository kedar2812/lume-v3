import { z } from "zod";
import type { Actor } from "../rbac/engine";

/**
 * Phase 6A (spec §2.2): the rules that watch for someone taking more lead data than their work needs. Pure:
 * the API counts and acts, the screens show the same limits. Every threshold and action is an admin setting.
 */
export type RuleId = "reveals" | "leadsOpened" | "queueRuns";
export type RuleAction = "off" | "alert" | "suspend";
export type RuleSetting = { action: RuleAction; threshold: number };
export type AnomalySettings = Record<RuleId, RuleSetting>;
export type WatermarkMode = "masked_roles" | "everyone" | "off";

export type RuleDef = {
  /** Counted over the last 60 minutes (rolling), or since the start of the business's day. */
  window: "hour" | "day";
  /** The audit action each counted act already writes (plan ruling R1). */
  audit: "lead.contact.reveal" | "lead.view" | "queue.started";
  /** Count different records (leads opened), not acts: a drawer refetching one lead counts once. */
  distinct: boolean;
  actions: readonly RuleAction[];
  step: number;
  min: number;
  max: number;
  default: RuleSetting;
};

export const RULE_IDS: readonly RuleId[] = ["reveals", "leadsOpened", "queueRuns"];

export const RULES: Record<RuleId, RuleDef> = {
  reveals: {
    window: "hour",
    audit: "lead.contact.reveal",
    distinct: false,
    actions: ["off", "alert", "suspend"],
    step: 5,
    min: 5,
    max: 500,
    default: { action: "suspend", threshold: 30 },
  },
  leadsOpened: {
    window: "hour",
    audit: "lead.view",
    distinct: true,
    actions: ["off", "alert", "suspend"],
    step: 25,
    min: 25,
    max: 5000,
    default: { action: "suspend", threshold: 200 },
  },
  // Running the queue is ordinary work; many runs in a day is worth a look, never a pause.
  queueRuns: {
    window: "day",
    audit: "queue.started",
    distinct: false,
    actions: ["off", "alert"],
    step: 1,
    min: 1,
    max: 50,
    default: { action: "alert", threshold: 3 },
  },
};

const clamp = (n: number, d: RuleDef) => Math.min(d.max, Math.max(d.min, Math.round(n)));

/** Stored settings over the defaults: anything unknown, or out of range, falls back or is clamped. */
export function mergeAnomaly(stored: unknown): AnomalySettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const out = {} as AnomalySettings;
  for (const id of RULE_IDS) {
    const d = RULES[id];
    const raw = (s[id] && typeof s[id] === "object" ? s[id] : {}) as {
      action?: unknown;
      threshold?: unknown;
    };
    const action = d.actions.includes(raw.action as RuleAction)
      ? (raw.action as RuleAction)
      : d.default.action;
    const threshold =
      typeof raw.threshold === "number" && Number.isFinite(raw.threshold)
        ? clamp(raw.threshold, d)
        : d.default.threshold;
    out[id] = { action, threshold };
  }
  return out;
}

const ruleSchema = (d: RuleDef) =>
  z.object({
    action: z.enum(d.actions as [RuleAction, ...RuleAction[]]),
    threshold: z.number().int().min(d.min).max(d.max),
  });

/** What Settings → Security saves: every rule, in range, and only the actions that rule can take. */
export const anomalySchema = z.object({
  reveals: ruleSchema(RULES.reveals),
  leadsOpened: ruleSchema(RULES.leadsOpened),
  queueRuns: ruleSchema(RULES.queueRuns),
});

export const watermarkSchema = z.enum(["masked_roles", "everyone", "off"]);

/**
 * Who the rules watch (plan ruling R2): not the owner, and not anyone who already sees every contact — they
 * gain nothing by scraping it. The same test as two-step sign-in's "full contacts at `all`".
 */
export function isWatched(actor: Pick<Actor, "isOwner" | "perms">): boolean {
  if (actor.isOwner) return false;
  return actor.perms.get("leads.contact.full") !== "all";
}

/** "More than 30": the 31st crosses the line, the 30th doesn't. */
export const breached = (observed: number, threshold: number): boolean => observed > threshold;

/** From 80% of a limit, LUME says once, calmly, that admins hear about unusual activity (spec §2.6). */
export const nearLimit = (observed: number, threshold: number): boolean =>
  observed >= Math.ceil(threshold * 0.8);

/** The on-screen watermark (spec §2.6): on by default for people who can't see every contact. */
export function showsWatermark(
  mode: WatermarkMode | undefined,
  actor: Pick<Actor, "isOwner" | "perms">,
): boolean {
  const m = mode ?? "masked_roles";
  if (m === "off") return false;
  if (m === "everyone") return true;
  return isWatched(actor);
}
