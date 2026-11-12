import { describe, expect, it } from "vitest";
import { AI_TASKS } from "./tasks";
import {
  AI_OUTPUT_TOKENS,
  aiPricingFrom,
  aiSpend,
  parseAiPrices,
  parseTaskModels,
  type AiPricing,
} from "./costs";

/** LUME AI's cost engine (2026-11-12): a model per action, prices per model with the cache, the month's spend. */
const sonnet = { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 };
const haiku = { in: 0.1, out: 0.5, cacheWrite: 0.125, cacheRead: 0.01 };
const pricing: AiPricing = { models: { "claude-sonnet-5-5": sonnet, "claude-haiku-5-5": haiku }, cap: 15 };
const row = (model: string, i = 0, o = 0, w = 0, r = 0) => ({
  model,
  inputTokens: i,
  outputTokens: o,
  cacheWriteTokens: w,
  cacheReadTokens: r,
});

describe("the tasks", () => {
  it("lists every read LUME AI makes, once", () => {
    expect([...AI_TASKS].sort()).toEqual(
      [
        "autopilot_first",
        "autopilot_reply",
        "catch_up",
        "next_step",
        "reply_meaning",
        "template_draft",
      ].sort(),
    );
  });
});

describe("room to answer", () => {
  it("every action has an output cap", () => {
    expect(Object.keys(AI_OUTPUT_TOKENS).sort()).toEqual([...AI_TASKS].sort());
  });
  it("template choice has room to think: 300 ran out mid-thought and was billed for nothing (measured 2026-11-12)", () => {
    expect(AI_OUTPUT_TOKENS.autopilot_first).toBeGreaterThanOrEqual(600);
  });
});

describe("a model per action (LUME_AI_TASK_MODELS)", () => {
  it("reads task=model pairs, spaces allowed", () => {
    expect(parseTaskModels("reply_meaning=claude-haiku-5-5, autopilot_first = claude-haiku-5-5")).toEqual({
      reply_meaning: "claude-haiku-5-5",
      autopilot_first: "claude-haiku-5-5",
    });
  });
  it("empty or unset is no overrides", () => {
    expect(parseTaskModels(undefined)).toEqual({});
    expect(parseTaskModels("  ")).toEqual({});
  });
  it("refuses an unknown task, a task named twice, or a pair without a model, naming the problem", () => {
    expect(() => parseTaskModels("reply_meaning=claude-haiku-5-5,lead_score=x")).toThrow(/lead_score/);
    expect(() => parseTaskModels("next_step=a,next_step=b")).toThrow(/twice/);
    expect(() => parseTaskModels("next_step=")).toThrow(/next_step/);
    expect(() => parseTaskModels("next_step")).toThrow(/next_step/);
    expect(() => parseTaskModels("next_step=has space")).toThrow(/has space/);
  });
});

describe("prices per model (LUME_AI_PRICES)", () => {
  it("reads model=in/out/cache write/cache read, in USD per million", () => {
    expect(parseAiPrices("claude-sonnet-5-5=2/10/2.5/0.1, claude-haiku-5-5=0.1/0.5/0.125/0.01")).toEqual({
      "claude-sonnet-5-5": sonnet,
      "claude-haiku-5-5": haiku,
    });
  });
  it("a free model may cost 0", () => {
    expect(parseAiPrices("local=0/0/0/0")).toEqual({ local: { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 } });
  });
  it("needs all four prices: the cache is never guessed", () => {
    expect(() => parseAiPrices("claude-sonnet-5-5=2/10")).toThrow(/claude-sonnet-5-5/);
  });
  it("refuses a negative price, a word, a model priced twice", () => {
    expect(() => parseAiPrices("m=-1/10/2.5/0.1")).toThrow(/m/);
    expect(() => parseAiPrices("m=two/10/2.5/0.1")).toThrow(/two/);
    expect(() => parseAiPrices("m=2/10/2.5/0.1,m=2/10/2.5/0.1")).toThrow(/twice/);
  });
});

describe("the pricing a server runs with", () => {
  const base = { model: "claude-sonnet-5-5", taskModels: { reply_meaning: "claude-haiku-5-5" }, cap: 15 };
  it("none set: no spend shown", () => {
    expect(aiPricingFrom({ ...base, prices: undefined, legacy: null })).toBeNull();
  });
  it("LUME_AI_PRICES prices every model it names", () => {
    expect(
      aiPricingFrom({
        ...base,
        prices: "claude-sonnet-5-5=2/10/2.5/0.1,claude-haiku-5-5=0.1/0.5/0.125/0.01",
        legacy: null,
      }),
    ).toEqual(pricing);
  });
  it("the legacy pair prices the default model, its cache at Anthropic's standard 1.25x and 0.1x of input", () => {
    expect(aiPricingFrom({ ...base, taskModels: {}, prices: undefined, legacy: { in: 2, out: 10 } })).toEqual(
      {
        models: { "claude-sonnet-5-5": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
        cap: 15,
      },
    );
  });
  it("a model the server can use without a price stops the server, naming it", () => {
    expect(() => aiPricingFrom({ ...base, prices: "claude-sonnet-5-5=2/10/2.5/0.1", legacy: null })).toThrow(
      /claude-haiku-5-5/,
    );
    expect(() => aiPricingFrom({ ...base, prices: undefined, legacy: { in: 2, out: 10 } })).toThrow(
      /claude-haiku-5-5/,
    );
  });
});

describe("the month's spend", () => {
  it("no prices: null, never a guess", () => {
    expect(aiSpend([row("claude-sonnet-5-5", 1, 1)], null)).toBeNull();
  });
  it("each model at its own prices, the cache at its own, to the cent", () => {
    const s = aiSpend(
      [
        // $2 + $1 + $0.25 + $0.01
        row("claude-sonnet-5-5", 1_000_000, 100_000, 100_000, 100_000),
        // $0.10 + $0.05
        row("claude-haiku-5-5", 1_000_000, 100_000),
      ],
      pricing,
    );
    expect(s).toEqual({ used: 3.41, cap: 15, currency: "USD" });
  });
  it("rounds the total once, not each model", () => {
    // $0.004 + $0.004 = $0.008 -> $0.01 (each alone would round to $0.00)
    expect(aiSpend([row("claude-sonnet-5-5", 2_000), row("claude-haiku-5-5", 40_000)], pricing)?.used).toBe(
      0.01,
    );
  });
  it("tokens from a model without a price hide the spend: part of it would be a lie", () => {
    expect(aiSpend([row("claude-sonnet-5-5", 1_000), row("gone-model", 5)], pricing)).toBeNull();
  });
  it("an unpriced model with no tokens (every read failed before answering) changes nothing", () => {
    expect(aiSpend([row("claude-sonnet-5-5", 1_000_000), row("gone-model")], pricing)?.used).toBe(2);
  });
  it("an empty month is $0", () => {
    expect(aiSpend([], pricing)).toEqual({ used: 0, cap: 15, currency: "USD" });
  });
});
