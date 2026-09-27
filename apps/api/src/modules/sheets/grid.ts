import { createHash } from "node:crypto";
import Papa from "papaparse";
import type { Mapping } from "@lume/core";

/** A row as numbered in the sheet; dateKey is its date cell as stored (unformatted), when there is one. */
export type SheetRow = { number: number; cells: string[]; dateKey?: string };
export type Drift = { broken: { column: number; was: string; now: string | null }[]; added: string[] };

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const norm = (s: string | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export const isBlank = (cells: string[]): boolean => cells.every((c) => c.trim() === "");

/**
 * Google's rows (trailing empty cells and rows left out) → rows as wide as the header. A blank row is
 * skipped, but every row keeps the number it has in the sheet, so "row 14" means row 14 there.
 */
export function toRows(raw: string[][], firstNumber: number, width: number): SheetRow[] {
  const out: SheetRow[] = [];
  raw.forEach((r, i) => {
    if (isBlank(r)) return;
    const cells = r.slice(0, width);
    while (cells.length < width) cells.push("");
    out.push({ number: firstNumber + i, cells });
  });
  return out;
}

/**
 * Spec §5.4. A mapped column whose header no longer matches (renamed, removed, or shifted by an inserted
 * column) is broken: LUME never guesses. Case and spacing don't count. Headers after the saved ones are
 * new columns, offered to map.
 */
export function headerDrift(saved: string[], now: string[], mapping: Mapping): Drift {
  const broken = mapping.columns
    .filter((c) => c.to !== "ignore" && norm(saved[c.column]) !== norm(now[c.column]))
    .map((c) => ({ column: c.column, was: saved[c.column] ?? "", now: now[c.column]?.trim() || null }));
  const added = now
    .slice(saved.length)
    .map((h) => h.trim())
    .filter(Boolean);
  return { broken, added };
}

/** Header, first data row and the last row read (amendment A4): if any changed, rows moved. */
export const anchorHash = (
  header: string[],
  first: string[] | undefined,
  tail: string[] | undefined,
): string => sha([header.map((h) => norm(h)), first ?? null, tail ?? null]);

const IDENTITY = ["lead_created_at", "phone", "email", "instagram"] as const;

/**
 * Amendment A6. A row is recognised by the raw cells of its date column (time included) and its contact
 * columns, so editing its name or an unmapped cell doesn't make it a new enquiry. It is read from the
 * cells alone, never from the mapped lead, so a change to fields, tags or rules can't make an old row
 * look new. A row with none of those filled is recognised by all its cells.
 */
export function sheetFingerprint(cells: string[], mapping: Mapping, dateKey?: string): string {
  const identity = IDENTITY.map((key) => {
    const c = mapping.columns.find((x) => x.to === "field" && x.field === key);
    // The date as stored, when known, so changing how the column looks doesn't make old rows new.
    if (c && key === "lead_created_at" && dateKey !== undefined) return dateKey.trim();
    return c ? (cells[c.column] ?? "").trim().toLowerCase() : "";
  });
  if (identity.some(Boolean)) return sha(["lead", ...identity]);
  return sha(["cells", ...cells.map((c) => c.trim())]);
}

/** A grid as the CSV a draft import reads (UTF-8, commas), so Columns, Rules and Preview work unchanged. */
export const gridToCsv = (rows: string[][]): string =>
  Papa.unparse(
    rows.map((r) => (r.length ? r : [""])),
    { newline: "\n" },
  );

/** The column mapped to the lead's date, if any: its stored value is part of a row's identity. */
export const dateColumnOf = (mapping: Mapping): number | null =>
  mapping.columns.find((x) => x.to === "field" && x.field === "lead_created_at")?.column ?? null;

/**
 * What a row's fingerprint depends on (amendment A6): which columns hold the date and the contacts, and
 * (for rows with none of those) how wide a row is. When an edit changes this, rows already dealt with
 * must be recognised again rather than imported again (final review, finding 1).
 */
export function identityKey(mapping: Mapping, width: number): string {
  const cols = IDENTITY.map(
    (key) => mapping.columns.find((x) => x.to === "field" && x.field === key)?.column ?? null,
  );
  return JSON.stringify([cols, width]);
}
