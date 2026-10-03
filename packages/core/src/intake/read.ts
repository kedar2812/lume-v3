import Papa from "papaparse";
import { INTAKE_LIMITS } from "./limits";

export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
export type Delimiter = "," | ";" | "\t" | "|";
export type FileRefusal = {
  ok: false;
  code: "FILE_EMPTY" | "FILE_TOO_BIG" | "TOO_MANY_ROWS" | "TOO_MANY_COLUMNS" | "NOT_CSV_EXCEL" | "NOT_TEXT";
  message: string;
};
export type FileWarning = { code: "ENCODING_GUESSED" | "RAGGED_ROWS"; message: string };
export type ReadCsv = {
  ok: true;
  encoding: Encoding;
  delimiter: Delimiter;
  /** 1-based record number of the header. */
  headerRow: number;
  headers: string[];
  rows: string[][];
  /** rowNumbers[i]: the 1-based record number of rows[i], for "row 14" in messages. */
  rowNumbers: number[];
  fileWarnings: FileWarning[];
};

const DELIMITERS: Delimiter[] = [",", ";", "\t", "|"];
const refuse = (code: FileRefusal["code"], message: string): FileRefusal => ({ ok: false, code, message });

/** 0 → "A", 25 → "Z", 26 → "AA", as a spreadsheet names its columns. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function isExcel(bytes: Uint8Array, fileName?: string): boolean {
  if (fileName && /\.(xlsx|xlsm|xls)$/i.test(fileName)) return true;
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  return zip || ole;
}

function decode(
  bytes: Uint8Array,
  forced?: Encoding,
): { text: string; encoding: Encoding; guessed: boolean } {
  const bom8 = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const bomLE = bytes[0] === 0xff && bytes[1] === 0xfe;
  const bomBE = bytes[0] === 0xfe && bytes[1] === 0xff;
  const pick = (enc: Encoding, from: number) =>
    new TextDecoder(enc, { ignoreBOM: true }).decode(bytes.subarray(from));
  if (forced) {
    const skip = forced === "utf-8" && bom8 ? 3 : forced.startsWith("utf-16") && (bomLE || bomBE) ? 2 : 0;
    return { text: pick(forced, skip), encoding: forced, guessed: false };
  }
  if (bom8) return { text: pick("utf-8", 3), encoding: "utf-8", guessed: false };
  if (bomLE) return { text: pick("utf-16le", 2), encoding: "utf-16le", guessed: false };
  if (bomBE) return { text: pick("utf-16be", 2), encoding: "utf-16be", guessed: false };
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8",
      guessed: false,
    };
  } catch {
    return { text: pick("windows-1252", 0), encoding: "windows-1252", guessed: true };
  }
}

// Line endings are normalised first, so a file mixing \r\n, \n and \r still splits on every one.
const parse = (text: string, delimiter: Delimiter, preview = 0): string[][] =>
  Papa.parse<string[]>(text, { delimiter, newline: "\n", quoteChar: '"', skipEmptyLines: false, preview })
    .data;

const blank = (r: string[]) => r.every((c) => c.trim() === "");

/** The most common width among non-blank records; a tie goes to the width seen first. */
function usualWidth(records: string[][]): number {
  const freq = new Map<number, number>();
  for (const r of records) if (!blank(r)) freq.set(r.length, (freq.get(r.length) ?? 0) + 1);
  let best = { width: 1, hits: 0 };
  for (const [width, hits] of freq) if (hits > best.hits) best = { width, hits }; // Map keeps first-seen order
  return best.width;
}

/** The delimiter whose rows agree most on a column count of 2 or more (over the first 50 lines). */
function detectDelimiter(text: string): Delimiter {
  let best: { d: Delimiter; score: number } = { d: ",", score: 0 };
  for (const d of DELIMITERS) {
    const records = parse(text, d, 50).filter((r) => !blank(r));
    const width = usualWidth(records);
    if (width < 2) continue;
    const hits = records.filter((r) => r.length === width).length;
    if (hits > best.score) best = { d, score: hits }; // ties keep the earlier (preferred) delimiter
  }
  return best.d;
}

/**
 * The header: the first record (among the first 10) at least as wide as the file's usual row with two or
 * more filled cells — which steps over a title line and blank lines above it.
 */
function detectHeader(records: string[][]): number {
  const width = usualWidth(records);
  const limit = Math.min(records.length, INTAKE_LIMITS.headerSearch);
  for (let i = 0; i < limit; i++) {
    const r = records[i]!;
    const filled = r.filter((c) => c.trim() !== "").length;
    if (r.length >= width && filled >= Math.min(2, width)) return i;
  }
  for (let i = 0; i < limit; i++) if (!blank(records[i]!)) return i;
  return 0;
}

export function nameHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `Column ${columnLetter(i)}`;
    const key = base.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** Spec §5.1: bytes → a table, or the one reason LUME can't read it. */
export function readCsv(
  bytes: Uint8Array,
  opts: {
    fileName?: string;
    encoding?: Encoding;
    delimiter?: Delimiter;
    headerRow?: number;
    /** A header with nothing under it is fine (a brand-new form sheet, 2B); a CSV upload refuses it. */
    allowNoRows?: boolean;
    /** More rows than an import takes (Trace reads a whole export: 6B review). */
    maxRows?: number;
  } = {},
): ReadCsv | FileRefusal {
  if (bytes.length > INTAKE_LIMITS.bytes)
    return refuse("FILE_TOO_BIG", "This file is over 10 MB. Split it into smaller files.");
  if (isExcel(bytes, opts.fileName))
    return refuse(
      "NOT_CSV_EXCEL",
      "This is an Excel file. Save it as CSV (File → Save as → CSV UTF-8) and upload that.",
    );
  const decoded = decode(bytes, opts.encoding);
  const text = decoded.text.replace(/\r\n?/g, "\n");
  if (text.includes("\u0000"))
    return refuse("NOT_TEXT", "LUME can't read this file as text. Upload a CSV file.");
  if (!text.trim()) return refuse("FILE_EMPTY", "This file is empty.");

  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const records = parse(text, delimiter);
  const headerIndex = opts.headerRow
    ? Math.max(0, Math.min(opts.headerRow, records.length) - 1)
    : detectHeader(records);
  const headerCells = records[headerIndex] ?? [];
  if (headerCells.length > INTAKE_LIMITS.columns)
    return refuse(
      "TOO_MANY_COLUMNS",
      `This file has ${headerCells.length} columns; LUME reads up to ${INTAKE_LIMITS.columns}.`,
    );

  let body = records.slice(headerIndex + 1).map((r, i) => ({ cells: r, number: headerIndex + i + 2 }));
  while (body.length && blank(body[body.length - 1]!.cells)) body.pop();
  if (!body.length && !opts.allowNoRows)
    return refuse("FILE_EMPTY", "LUME found a header but no rows under it.");
  const maxRows = opts.maxRows ?? INTAKE_LIMITS.rows;
  if (body.length > maxRows)
    return refuse(
      "TOO_MANY_ROWS",
      `This file has ${body.length.toLocaleString("en")} rows; LUME imports up to ${maxRows.toLocaleString("en")} at a time.`,
    );

  const width = headerCells.length;
  let ragged = 0;
  body = body.map((b) => {
    if (b.cells.length !== width) ragged++;
    return b.cells.length < width
      ? { ...b, cells: [...b.cells, ...Array<string>(width - b.cells.length).fill("")] }
      : b;
  });

  const fileWarnings: FileWarning[] = [];
  if (decoded.guessed)
    fileWarnings.push({
      code: "ENCODING_GUESSED",
      message: "Some characters may be wrong — check the accents in the preview.",
    });
  if (ragged)
    fileWarnings.push({
      code: "RAGGED_ROWS",
      message: `${ragged} ${ragged === 1 ? "row has" : "rows have"} a different number of cells from the header.`,
    });

  return {
    ok: true,
    encoding: decoded.encoding,
    delimiter,
    headerRow: headerIndex + 1,
    headers: nameHeaders(headerCells),
    rows: body.map((b) => b.cells),
    rowNumbers: body.map((b) => b.number),
    fileWarnings,
  };
}
