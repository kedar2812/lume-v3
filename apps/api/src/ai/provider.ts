import { z } from "zod";

/** The provider answered, but not in the shape asked for (or declined): LUME shows no suggestion. */
export class AiUnreadable extends Error {
  constructor(why: string) {
    super(`LUME AI couldn't read the answer: ${why}`);
    this.name = "AiUnreadable";
  }
}

export type AiRead<T> = {
  instructions: string;
  input: string;
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  signal: AbortSignal;
};
export type AiAnswer<T> = { output: T; inputTokens: number; outputTokens: number };

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

/** The provider's text as the task's shape, or `AiUnreadable`. */
export function parseAnswer<T>(text: string, schema: z.ZodType<T>): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiUnreadable("not JSON");
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new AiUnreadable(r.error.issues[0]?.message ?? "not the shape asked for");
  return r.data;
}
