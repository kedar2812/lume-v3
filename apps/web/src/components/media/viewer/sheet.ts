import * as XLSX from "xlsx";

/** One sheet as LUME's viewer shows it: its first row as the header, the rest as text the way Excel shows it. */
export type Sheet = {
  name: string;
  header: string[];
  rows: string[][];
  /** Columns that hold numbers, set on the right. */
  numeric: boolean[];
  /** How many rows the sheet has below its header, whether or not all are shown. */
  total: number;
};

/** The most rows read from a sheet: enough for any price list; a lead export is read in Leads, not here. */
export const MAX_ROWS = 2000;
/** The most columns shown: past this a sheet is a database, not something to read on a screen. */
export const MAX_COLUMNS = 60;

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const starts = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

/**
 * Read an Excel file (.xlsx or .xls) with SheetJS. Only a real workbook is read: SheetJS would happily read an HTML
 * page or a CSV as a "spreadsheet", so anything without a workbook's own first bytes is refused. Reading stops after
 * MAX_ROWS rows, however many the file claims, so a huge or hostile sheet can't eat the browser's memory.
 */
export function readSheets(buf: ArrayBuffer, maxRows = MAX_ROWS): Sheet[] {
  const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  if (!starts(head, ZIP) && !starts(head, OLE)) throw new Error("not a workbook");
  const wb = XLSX.read(buf, {
    type: "array",
    sheetRows: maxRows + 1,
    dense: true,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
  });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]!;
    const full = (ws["!fullref"] as string | undefined) ?? ws["!ref"];
    const total = full
      ? Math.max(0, XLSX.utils.decode_range(full).e.r - XLSX.utils.decode_range(full).s.r)
      : 0;
    const shown = XLSX.utils.sheet_to_json<string[]>(ws, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    const width = Math.min(MAX_COLUMNS, Math.max(0, ...shown.map((r) => r.length)));
    const pad = (r: string[]) => Array.from({ length: width }, (_, i) => String(r[i] ?? ""));
    const numeric = Array.from({ length: width }, (_, c) => {
      const cells = raw
        .slice(1)
        .map((r) => r[c])
        .filter((x) => x !== null && x !== "");
      return cells.length > 0 && cells.filter((x) => typeof x === "number").length / cells.length >= 0.8;
    });
    return {
      name,
      header: shown[0] ? pad(shown[0]) : [],
      rows: shown.slice(1, maxRows + 1).map(pad),
      numeric,
      total: shown.length ? Math.max(total, shown.length - 1) : 0,
    };
  });
}
