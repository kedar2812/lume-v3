import { fitAnswer } from "@lume/core";
import { z } from "zod";

/**
 * What one answer cost, as the provider counts it (2026-11-12): input not from the cache, output (thinking included),
 * and the cache's writes and reads. Each is priced on its own.
 */
export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

/**
 * The provider answered, but not in the shape asked for (or declined, or was cut short): LUME shows no suggestion. The
 * answer was still billed, so it carries its usage (2026-11-12): the read keeps its tokens.
 */
export class AiUnreadable extends Error {
  readonly reason: string;
  readonly usage: AiUsage | null;
  constructor(why: string, usage: AiUsage | null = null) {
    super(`LUME AI couldn't read the answer: ${why}`);
    this.name = "AiUnreadable";
    this.reason = why;
    this.usage = usage;
  }
}

export type AiRead<T> = {
  /** The model for this read (a model per action, 2026-11-12); the provider's own when unset. */
  model?: string;
  instructions: string;
  input: string;
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  signal: AbortSignal;
};
/** The cache's counts are 0 when a provider has none (the fake); `model` is the one that served the read. */
export type AiAnswer<T> = {
  output: T;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
};

/**
 * LUME AI's one plug (spec 2026-10-18 §2.1): callers never know which provider runs. A transport failure or an
 * abort rejects with that error; an answer that doesn't validate rejects with `AiUnreadable`.
 */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  read<T>(o: AiRead<T>): Promise<AiAnswer<T>>;
}

/** Limits that not every provider's structured output accepts; zod checks them on the way back instead. */
const DROPPED = new Set(["$schema", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format"]);

/**
 * The task's schema as plain JSON Schema for a provider: every key required, no others, nullable as anyOf, a
 * tuple as a list. Whatever comes back is still validated against the zod schema itself.
 */
export function schemaForProvider(schema: z.ZodType): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (DROPPED.has(k)) continue;
      if (k === "prefixItems") {
        out.items = walk((x as unknown[])[0]);
        continue;
      }
      out[k] = walk(x);
    }
    return out;
  };
  return walk(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/**
 * The provider's text as the task's shape, or `AiUnreadable`. An explanation a few characters past its limit is
 * shortened first (`fitAnswer`); a message to a lead or a value for one never is.
 */
export function parseAnswer<T>(text: string, schema: z.ZodType<T>, usage: AiUsage | null = null): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiUnreadable("not JSON", usage);
  }
  const r = schema.safeParse(fitAnswer(schema, json));
  if (!r.success) throw new AiUnreadable(r.error.issues[0]?.message ?? "not the shape asked for", usage);
  return r.data;
}
