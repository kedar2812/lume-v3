import type { FieldType } from "../leads/custom-fields";
import type { Issue, Mapping } from "./mapping";
import { normalizePhone } from "../leads/phone";
import {
  defaultDecimalMark,
  detectDateOrder,
  detectDecimalMark,
  fold,
  parseBoolean,
  parseDate,
  parseNumber,
  readEmail,
  readUrl,
} from "./values";

/**
 * What a column holds, read from every row (imports, 2026-10-25: a lead ads export's empty column became a field and its
 * budget came in as text): how many rows fill it, the kind of values they are, and the field a new one from it should be.
 */
export type ColumnProfile = {
  column: number;
  /** Rows with something in this column. */
  filled: number;
  kind: "empty" | "number" | "money" | "date" | "boolean" | "email" | "url" | "phone" | "choice" | "text";
  /** A choice's values, in the order they first appear, one spelling each. */
  values?: string[];
  /** A choice whose cells hold several values ("Kitchen, Bedroom"). */
  multi?: boolean;
  /** The type a new field made from this column starts as (the person can change it). */
  suggest: FieldType;
};

/** At most this many different values make a column a choice, and only when they repeat (each used 3 times on average). */
const CHOICES_MAX = 12;
const SPLIT = /\s*[,;]\s*/;
const MONEY_HEADER = /\b(budget|price|amount|cost|fee|fees|value|salary|revenue|spend|deal)\b/i;
const CURRENCY_MARK = /[₹$€£¥]|\b(inr|aed|usd|eur|gbp|sar|rs\.?)\b/i;
const LONG_TEXT = 200;

const all = (values: string[], ok: (v: string) => boolean) => values.length > 0 && values.every(ok);

export function profileColumns(
  rows: string[][],
  headers: string[],
  o: { country: string | null },
): ColumnProfile[] {
  const today = "9999-12-31"; // only whether a value reads as a date is asked here: a future day is fine
  return headers.map((header, column) => {
    const values = rows.map((r) => (r[column] ?? "").trim()).filter(Boolean);
    const base = { column, filled: values.length };
    if (!values.length) return { ...base, kind: "empty", suggest: "text" };
    const words = header.replace(/_/g, " ");

    if (all(values, (v) => parseBoolean(v) !== null) && values.some((v) => !/^\d$/.test(v)))
      return { ...base, kind: "boolean", suggest: "boolean" };
    if (all(values, (v) => readEmail(v) !== null)) return { ...base, kind: "email", suggest: "email" };
    if (all(values, (v) => /^(https?:\/\/|www\.)/i.test(v) && readUrl(v) !== null))
      return { ...base, kind: "url", suggest: "url" };
    const order = detectDateOrder(values);
    const asDate = order === "conflict" ? null : order === "ambiguous" ? "DMY" : order;
    if (
      asDate &&
      all(values, (v) => /[-/.\s]/.test(v) && parseDate(v, asDate, { today, timezone: "UTC" }).ok)
    )
      return { ...base, kind: "date", suggest: "date" };

    const decimal = detectDecimalMark(values, defaultDecimalMark(o.country));
    const bare = (v: string) => v.replace(CURRENCY_MARK, "").trim();
    const numeric = all(values, (v) => parseNumber(bare(v), decimal).ok);
    if (numeric && (values.some((v) => CURRENCY_MARK.test(v)) || MONEY_HEADER.test(words)))
      return { ...base, kind: "money", suggest: "currency" };
    const phoneLike = (v: string) => {
      const digits = v.replace(/\D/g, "");
      return /^\+?[\d\s().-]+$/.test(v) && digits.length >= 8 && digits.length <= 15;
    };
    if (all(values, phoneLike) && all(values, (v) => normalizePhone(v, o.country).status !== "invalid"))
      return { ...base, kind: "phone", suggest: "phone" };
    if (numeric) return { ...base, kind: "number", suggest: "number" };

    const multi = values.some((v) => SPLIT.test(v));
    const parts = multi ? values.flatMap((v) => v.split(SPLIT).filter(Boolean)) : values;
    const distinct = uniqueByFold(parts);
    if (distinct.length <= CHOICES_MAX && parts.length >= distinct.length * 3)
      return { ...base, kind: "choice", values: distinct, multi, suggest: multi ? "multi_select" : "select" };

    return {
      ...base,
      kind: "text",
      suggest: values.some((v) => v.length > LONG_TEXT) ? "long_text" : "text",
    };
  });
}

function uniqueByFold(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) if (!seen.has(fold(v))) seen.set(fold(v), v);
  return [...seen.values()];
}

/** A new choice field's options: every value in the column, first spelling first, split when cells hold several. */
export function choicesOf(rows: string[][], column: number, multi: boolean): string[] {
  const values = rows.map((r) => (r[column] ?? "").trim()).filter(Boolean);
  return uniqueByFold(multi ? values.flatMap((v) => v.split(SPLIT).filter(Boolean)) : values);
}

/** A choice field holds at most this many options (the Fields screen's own limit). */
export const CHOICE_OPTIONS_MAX = 100;
const CHOICE_LABEL_MAX = 60;

/** What stops a column becoming a new field: nothing in it, or more values than a choice field can hold. */
export function newFieldProblems(m: Mapping, profiles: ColumnProfile[], rows: string[][]): Issue[] {
  const out: Issue[] = [];
  for (const c of m.columns) {
    if (c.to !== "new_field") continue;
    const p = profiles.find((x) => x.column === c.column);
    if (p?.kind === "empty") {
      out.push({
        column: c.column,
        code: "NEW_FIELD_EMPTY",
        message: "This column is empty in every row, so there's nothing to keep.",
      });
      continue;
    }
    if (c.type === "select" || c.type === "multi_select") {
      const choices = choicesOf(rows, c.column, c.type === "multi_select");
      const n = choices.length;
      if (choices.some((x) => x.length > CHOICE_LABEL_MAX))
        out.push({
          column: c.column,
          code: "NEW_FIELD_CHOICE_TOO_LONG",
          message: `A choice can be up to ${CHOICE_LABEL_MAX} characters, and this column has longer values. Make it Text.`,
        });
      else if (n > CHOICE_OPTIONS_MAX)
        out.push({
          column: c.column,
          code: "NEW_FIELD_TOO_MANY_CHOICES",
          message: `This column has ${n.toLocaleString("en-US")} different values; a choice field holds up to ${CHOICE_OPTIONS_MAX}. Make it Text.`,
        });
    }
  }
  return out;
}
