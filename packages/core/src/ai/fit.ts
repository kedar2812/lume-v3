import { z } from "zod";

/**
 * The words a person reads about an answer (a summary, a why, a title), which LUME may shorten when a model runs a few
 * characters past the limit, instead of throwing the whole answer away (eval 2026-10-31: 24 of Haiku 5.5's 165
 * answers). Never a message sent to a lead or a value written on one: those keep failing safe. Kept in a registry of
 * LUME's own, so nothing about it is ever sent to a provider.
 */
const soft = z.registry<Record<string, never>>();

/** A string a model writes for a person to read, at most `max` characters (and at least `min`). */
export function softText(max: number, min = 0): z.ZodString {
  const s = (min ? z.string().min(min) : z.string()).max(max);
  soft.add(s, {});
  return s;
}

/** `text` within `max` characters: cut at a word where one is near, never mid-surrogate, ending with an ellipsis. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const wordEnds = /\s/.test(text[cut.length] ?? "");
  const space = cut.lastIndexOf(" ");
  if (!wordEnds && space > max / 2) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:.-]+$/u, "")}…`;
}

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  innerType?: z.ZodType;
  element?: z.ZodType;
};

/** `value` with every soft text in it shortened to its schema's limit; anything else is returned as it was given. */
export function fitAnswer(schema: z.ZodType, value: unknown): unknown {
  const def = (schema as unknown as { _zod: { def: Def } })._zod.def;
  switch (def.type) {
    case "string": {
      const max = (schema as z.ZodString).maxLength;
      return typeof value === "string" && max !== null && soft.has(schema) ? clipText(value, max) : value;
    }
    case "nullable":
    case "optional":
      return value === null || value === undefined ? value : fitAnswer(def.innerType!, value);
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const [k, s] of Object.entries(def.shape ?? {})) if (k in out) out[k] = fitAnswer(s, out[k]);
      return out;
    }
    case "array":
      return Array.isArray(value) ? value.map((v) => fitAnswer(def.element!, v)) : value;
    default:
      return value;
  }
}
