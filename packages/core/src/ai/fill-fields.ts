import type { FieldType } from "../leads/custom-fields";

/**
 * "Fill in lead details" (Autopilot spec 2026-10-19 §1.3): the field types LUME AI may fill from what a lead said. Never
 * a contact (phone, email, web address, Instagram), a person, or a moment with a time zone to guess.
 */
export const FILLABLE_TYPES = [
  "text",
  "long_text",
  "number",
  "currency",
  "date",
  "boolean",
  "select",
  "multi_select",
] as const satisfies readonly FieldType[];
export type FillableType = (typeof FILLABLE_TYPES)[number];

const AMOUNT = /^(?:₹|rs\.?|inr|aed|usd|\$|€|£)?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:₹|rs\.?|inr|aed|usd)?$/i;

/**
 * LUME AI's words for a field as the value the field holds, or undefined when they don't fit it: a number as written
 * (grouping and a currency sign allowed, never words like "lakh"), a real calendar day, yes or no, a choice by one of its
 * live labels (any case).
 */
export function fieldValueFrom(
  f: { type: FillableType; options: { id: string; label: string; archived?: boolean }[] },
  text: string,
): string | number | boolean | string[] | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const choice = (s: string) =>
    f.options.find((o) => !o.archived && o.label.trim().toLowerCase() === s.trim().toLowerCase())?.id;
  switch (f.type) {
    case "text":
    case "long_text":
      return t;
    case "number":
    case "currency": {
      const m = AMOUNT.exec(t);
      if (!m) return undefined;
      const n = Number(m[1]!.replace(/,/g, ""));
      if (!Number.isFinite(n)) return undefined;
      if (f.type === "currency" && !/^\d+(?:\.\d{1,2})?$/.test(m[1]!.replace(/,/g, ""))) return undefined;
      return n;
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return undefined;
      const d = new Date(`${t}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t ? t : undefined;
    }
    case "boolean":
      return /^(yes|true)$/i.test(t) ? true : /^(no|false)$/i.test(t) ? false : undefined;
    case "select":
      return choice(t);
    case "multi_select": {
      const ids = t.split(",").map(choice);
      if (ids.some((x) => !x)) return undefined;
      return [...new Set(ids as string[])];
    }
  }
}
