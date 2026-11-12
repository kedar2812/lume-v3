import { AI_TASKS, type AiTask } from "./tasks";

/**
 * LUME AI's cost engine (2026-11-12): which model each action runs on, what each model's tokens cost, and the month's
 * spend. Pure: the API reads `.env` and the month's tokens, this decides. Prices are always the owner's, in USD per
 * million tokens, and a spend that can't be priced in full is never shown.
 */
export type AiPrice = { in: number; out: number; cacheWrite: number; cacheRead: number };
export type AiPricing = { models: Record<string, AiPrice>; cap: number | null };
/** One model's tokens in the month: every finished read, good or failed (a failed answer was billed too). */
export type AiModelTokens = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

/**
 * How much each action may write, thinking included (billed only as used). Template choice answers in about 90 tokens
 * but thinks first: at 300 one measured read ran out mid-thought and was billed for nothing (2026-11-12).
 */
export const AI_OUTPUT_TOKENS: Record<AiTask, number> = {
  next_step: 2000,
  catch_up: 1500,
  autopilot_first: 600,
  autopilot_reply: 1200,
  reply_meaning: 1000,
  template_draft: 1600,
};

/** A model id as providers write them: letters, digits and . _ : @ / - (no spaces). */
const MODEL = /^[A-Za-z0-9._:@/-]{1,100}$/;
const PRICE = /^\d+(?:\.\d+)?$/;

/** `a=b, c=d` as pairs, each side trimmed; empty or unset is none. */
function pairs(list: string | undefined, what: string): [string, string][] {
  if (!list?.trim()) return [];
  return list.split(",").map((part) => {
    const at = part.indexOf("=");
    const k = (at < 0 ? part : part.slice(0, at)).trim();
    const v = at < 0 ? "" : part.slice(at + 1).trim();
    if (!k || !v) throw new Error(`${what}: "${part.trim()}" needs the form name=value`);
    return [k, v];
  });
}

/** `LUME_AI_TASK_MODELS`: the actions that run on another model than `LUME_AI_MODEL`. */
export function parseTaskModels(list: string | undefined): Partial<Record<AiTask, string>> {
  const out: Partial<Record<AiTask, string>> = {};
  for (const [task, model] of pairs(list, "LUME_AI_TASK_MODELS")) {
    if (!(AI_TASKS as readonly string[]).includes(task))
      throw new Error(`LUME_AI_TASK_MODELS: "${task}" isn't a LUME AI action (${AI_TASKS.join(", ")})`);
    if (task in out) throw new Error(`LUME_AI_TASK_MODELS: "${task}" is named twice`);
    if (!MODEL.test(model)) throw new Error(`LUME_AI_TASK_MODELS: "${model}" isn't a model id`);
    out[task as AiTask] = model;
  }
  return out;
}

/** `LUME_AI_PRICES`: model=in/out/cache write/cache read, USD per million tokens. All four, always. */
export function parseAiPrices(list: string | undefined): Record<string, AiPrice> {
  const out: Record<string, AiPrice> = {};
  for (const [model, v] of pairs(list, "LUME_AI_PRICES")) {
    if (!MODEL.test(model)) throw new Error(`LUME_AI_PRICES: "${model}" isn't a model id`);
    if (model in out) throw new Error(`LUME_AI_PRICES: "${model}" is priced twice`);
    const n = v.split("/").map((x) => x.trim());
    if (n.length !== 4)
      throw new Error(`LUME_AI_PRICES: "${model}" needs four prices: input/output/cache write/cache read`);
    const bad = n.find((x) => !PRICE.test(x));
    if (bad !== undefined) throw new Error(`LUME_AI_PRICES: "${bad}" (for ${model}) isn't a price`);
    const [i, o, w, r] = n.map(Number) as [number, number, number, number];
    out[model] = { in: i, out: o, cacheWrite: w, cacheRead: r };
  }
  return out;
}

/**
 * The prices this server runs with, or null (no spend shown). `LUME_AI_PRICES` wins; the legacy pair prices the default
 * model only, its cache at Anthropic's standard multipliers (writes 1.25x input, reads 0.1x: an upper bound on current
 * models). With prices set, every model the server can use must have one, or this throws and the server doesn't start.
 */
export function aiPricingFrom(o: {
  model: string | undefined;
  taskModels: Partial<Record<AiTask, string>>;
  prices: string | undefined;
  legacy: { in: number; out: number } | null;
  cap: number | null;
}): AiPricing | null {
  const listed = parseAiPrices(o.prices);
  const models: Record<string, AiPrice> = Object.keys(listed).length
    ? listed
    : o.legacy && o.model
      ? { [o.model]: { ...o.legacy, cacheWrite: o.legacy.in * 1.25, cacheRead: o.legacy.in * 0.1 } }
      : {};
  if (!Object.keys(models).length) return null;
  const used = [...new Set([o.model, ...Object.values(o.taskModels)].filter((m): m is string => !!m))];
  const missing = used.filter((m) => !(m in models));
  if (missing.length)
    throw new Error(
      `LUME_AI_PRICES: no price for ${missing.join(", ")}. Price every model LUME AI uses, or set no prices.`,
    );
  return { models, cap: o.cap };
}

/**
 * The month's spend at the owner's prices, to the cent (rounded once, on the total). Null with no prices, or when any
 * tokens this month came from a model without a price: part of a spend would read as all of it.
 */
export function aiSpend(
  month: AiModelTokens[],
  pricing: AiPricing | null,
): { used: number; cap: number | null; currency: "USD" } | null {
  if (!pricing) return null;
  let used = 0;
  for (const m of month) {
    const tokens = m.inputTokens + m.outputTokens + m.cacheWriteTokens + m.cacheReadTokens;
    if (!tokens) continue;
    const p = pricing.models[m.model];
    if (!p) return null;
    used +=
      (m.inputTokens * p.in +
        m.outputTokens * p.out +
        m.cacheWriteTokens * p.cacheWrite +
        m.cacheReadTokens * p.cacheRead) /
      1_000_000;
  }
  return { used: Math.round(used * 100) / 100, cap: pricing.cap, currency: "USD" };
}
