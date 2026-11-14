import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/** Meta's customer list column names, in the order the sheet writes them; `value` only for a rule with a won stage. */
export const META_COLUMNS = ["email", "phone", "fn", "ln", "country"] as const;
export const metaColumns = (includesWon: boolean): string[] => [
  ...META_COLUMNS,
  ...(includesWon ? ["value"] : []),
];

/** First and last name, as Meta reads them: the first word, then the rest. */
export function splitName(name: string): { fn: string; ln: string } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return { fn: words[0] ?? "", ln: words.slice(1).join(" ") };
}

/** The two-letter country of a phone kept as digits with its country code, or null when it can't be placed. */
export function countryOfPhone(digits: string): string | null {
  if (!/^\d{6,15}$/.test(digits)) return null;
  return parsePhoneNumberFromString(`+${digits}`)?.country ?? null;
}

export type SheetCell = string | number | null;
export type SheetRow = { leadId: string; cells: SheetCell[] };

/** Google keeps at most 50,000 characters in a cell. */
export const CELL_MAX = 50_000;
export const cellText = (v: SheetCell): string => (v === null ? "" : String(v)).slice(0, CELL_MAX);
