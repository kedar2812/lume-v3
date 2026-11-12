import { aiPricingFrom, parseTaskModels, type AiPricing, type AiTask } from "@lume/core";
import { anthropicProvider } from "./anthropic";
import { fakeProvider } from "./fake";
import { googleProvider } from "./google";
import type { AiProvider } from "./provider";

/** The provider this server is set up for (`.env`), or null: no LUME AI here. */
export function providerFromConfig(cfg: {
  LUME_AI_PROVIDER?: "anthropic" | "google" | "fake" | undefined;
  LUME_AI_MODEL?: string | undefined;
  LUME_AI_KEY?: string | undefined;
}): AiProvider | null {
  switch (cfg.LUME_AI_PROVIDER) {
    case "anthropic":
      return anthropicProvider({ apiKey: cfg.LUME_AI_KEY!, model: cfg.LUME_AI_MODEL! });
    case "google":
      return googleProvider({ apiKey: cfg.LUME_AI_KEY!, model: cfg.LUME_AI_MODEL! });
    case "fake":
      return fakeProvider();
    default:
      return null;
  }
}

/**
 * LUME AI as this server is set up (2026-11-12): the provider, the actions that run on another model
 * (LUME_AI_TASK_MODELS), and the owner's prices for every model it can use (LUME_AI_PRICES, or the legacy pair for the
 * default model). A list that doesn't read, or a model it can use without a price, throws: the server doesn't start.
 */
export function aiFromConfig(cfg: {
  LUME_AI_PROVIDER?: "anthropic" | "google" | "fake" | undefined;
  LUME_AI_MODEL?: string | undefined;
  LUME_AI_KEY?: string | undefined;
  LUME_AI_TASK_MODELS?: string | undefined;
  LUME_AI_PRICES?: string | undefined;
  LUME_AI_PRICE_IN?: number | undefined;
  LUME_AI_PRICE_OUT?: number | undefined;
  LUME_AI_MONTHLY_CAP?: number | undefined;
}): { ai: AiProvider | null; aiModels: Partial<Record<AiTask, string>>; aiPricing: AiPricing | null } {
  const ai = providerFromConfig(cfg);
  const aiModels = ai ? parseTaskModels(cfg.LUME_AI_TASK_MODELS) : {};
  const aiPricing = aiPricingFrom({
    model: ai?.model,
    taskModels: aiModels,
    prices: cfg.LUME_AI_PRICES,
    legacy:
      cfg.LUME_AI_PRICE_IN !== undefined && cfg.LUME_AI_PRICE_OUT !== undefined
        ? { in: cfg.LUME_AI_PRICE_IN, out: cfg.LUME_AI_PRICE_OUT }
        : null,
    cap: cfg.LUME_AI_MONTHLY_CAP ?? null,
  });
  return { ai, aiModels, aiPricing };
}
