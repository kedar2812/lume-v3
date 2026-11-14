import { randomBytes } from "node:crypto";
import type http from "node:http";

/**
 * Live sheets (2026-11-14): the spreadsheets LUME makes (drive.file), as Google keeps them: tabs of rows, each row
 * with its cells, their kinds and background colours, and the developer metadata that tags it with a lead. Every
 * batchUpdate is applied whole or not at all, as Google's is. Plugged into google-fake.ts.
 */
export type MadeCell = string | number;
export type MadeRow = {
  lead: string | null;
  cells: MadeCell[];
  kinds: ("string" | "number" | "formula" | "empty")[];
  bg: (string | null)[];
  bold: boolean;
};
export type MadeTab = { sheetId: number; title: string; frozen: number; rows: MadeRow[] };
export type MadeSpreadsheet = {
  id: string;
  title: string;
  trashed: boolean;
  tabs: MadeTab[];
  modified: number;
};

export type MadeSheets = {
  /** The Google account a grant belongs to, as Drive's about says it. */
  accountEmail: string;
  get(id: string): MadeSpreadsheet | undefined;
  all(): MadeSpreadsheet[];
  /** A person edits a cell (row and column 0-based, row 0 the header). */
  editCell(id: string, tab: number, row: number, col: number, value: string): void;
  /** A person types a row of their own at `row` (no tag). */
  insertByHand(id: string, tab: number, row: number, cells: string[]): void;
  deleteRow(id: string, tab: number, row: number): void;
  /** A row tagged with a lead, as LUME writes one (to arrange a state LUME left behind). */
  insertTagged(id: string, tab: number, row: number, lead: string, cells: string[]): void;
  /** A person sorts the data rows (under the header) by a column; tags move with their rows. */
  sort(id: string, tab: number, col: number, dir: "asc" | "desc"): void;
  /** The person deletes the file in Google: everything about it answers 404. */
  removeFile(id: string): void;
  /** The next batchUpdate is refused with this status, unapplied. */
  failNextBatch(status: number): void;
  /** The next batchUpdate is applied, then answered with this status (the answer was lost). */
  failAfterApply(status: number): void;
  reset(): void;
};

type Send = (res: http.ServerResponse, status: number, body: unknown) => void;
type Err = (res: http.ServerResponse, status: number, code: string, message: string) => void;

const hex = (c?: { red?: number; green?: number; blue?: number }) =>
  c
    ? `#${[c.red, c.green, c.blue]
        .map((v) =>
          Math.round((v ?? 0) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`
    : null;
const blank = (n: number): MadeRow => ({
  lead: null,
  cells: Array(n).fill(""),
  kinds: Array(n).fill("empty"),
  bg: Array(n).fill(null),
  bold: false,
});
const fit = (r: MadeRow, n: number) => {
  while (r.cells.length < n) {
    r.cells.push("");
    r.kinds.push("empty");
    r.bg.push(null);
  }
};

export function madeSheets(o: { send: Send; googleError: Err; tick: () => number }) {
  const sheets = new Map<string, MadeSpreadsheet>();
  let nextSheetId = 100;
  let refuse: number | null = null;
  let afterApply: number | null = null;

  const live = (id: string) => {
    const s = sheets.get(id);
    return s && !s.trashed ? s : undefined;
  };
  const tabById = (s: MadeSpreadsheet, sheetId: number) => {
    const t = s.tabs.find((x) => x.sheetId === sheetId);
    if (!t) throw new Error(`No grid with id: ${sheetId}`);
    return t;
  };

  type Req = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  function apply(s: MadeSpreadsheet, r: Req) {
    if (r.updateCells) {
      const { start, rows, fields } = r.updateCells as Req;
      const t = tabById(s, start.sheetId);
      const f = String(fields ?? "");
      (rows as Req[]).forEach((row, i) => {
        const at = start.rowIndex + i;
        while (t.rows.length <= at) t.rows.push(blank(0));
        const target = t.rows[at]!;
        (row.values as Req[] | undefined)?.forEach((v, j) => {
          const col = start.columnIndex + j;
          fit(target, col + 1);
          if (f.includes("userEnteredValue")) {
            const u = (v.userEnteredValue ?? {}) as Req;
            if (u.formulaValue !== undefined) {
              target.cells[col] = String(u.formulaValue);
              target.kinds[col] = "formula";
            } else if (u.numberValue !== undefined) {
              target.cells[col] = Number(u.numberValue);
              target.kinds[col] = "number";
            } else if (u.stringValue !== undefined && u.stringValue !== "") {
              target.cells[col] = String(u.stringValue);
              target.kinds[col] = "string";
            } else {
              target.cells[col] = "";
              target.kinds[col] = "empty";
            }
          }
          if (f.includes("backgroundColor")) target.bg[col] = hex(v.userEnteredFormat?.backgroundColor);
          if (f.includes("textFormat") && v.userEnteredFormat?.textFormat?.bold) target.bold = true;
        });
      });
      return {};
    }
    if (r.insertDimension) {
      const { range } = r.insertDimension as Req;
      const t = tabById(s, range.sheetId);
      const n = range.endIndex - range.startIndex;
      t.rows.splice(range.startIndex, 0, ...Array.from({ length: n }, () => blank(0)));
      return {};
    }
    if (r.deleteDimension) {
      const { range } = r.deleteDimension as Req;
      const t = tabById(s, range.sheetId);
      if (range.endIndex > t.rows.length) throw new Error("Invalid requests: deleteDimension beyond grid");
      t.rows.splice(range.startIndex, range.endIndex - range.startIndex);
      return {};
    }
    if (r.createDeveloperMetadata) {
      const m = (r.createDeveloperMetadata as Req).developerMetadata as Req;
      const d = m.location.dimensionRange as Req;
      const t = tabById(s, d.sheetId);
      if (m.metadataKey !== "lume.lead" || d.endIndex - d.startIndex !== 1)
        throw new Error("fake: one row per tag");
      const row = t.rows[d.startIndex];
      if (!row) throw new Error("Invalid requests: metadata beyond grid");
      row.lead = String(m.metadataValue);
      return {};
    }
    if (r.updateSpreadsheetProperties) {
      s.title = String((r.updateSpreadsheetProperties as Req).properties.title);
      return {};
    }
    if (r.updateSheetProperties) {
      const p = (r.updateSheetProperties as Req).properties as Req;
      const t = tabById(s, p.sheetId);
      if (p.title !== undefined) t.title = String(p.title);
      if (p.gridProperties?.frozenRowCount !== undefined) t.frozen = Number(p.gridProperties.frozenRowCount);
      return {};
    }
    if (r.updateDimensionProperties) return {};
    throw new Error(`fake: unknown request ${Object.keys(r).join(",")}`);
  }

  /** True when the request was one of these routes (answered); false to let google-fake carry on. */
  async function handle(
    req: http.IncomingMessage,
    u: URL,
    res: http.ServerResponse,
    viaGrant: boolean,
    body: () => Promise<Req>,
  ): Promise<boolean> {
    const p = u.pathname;
    if (p === "/drive/v3/about" && req.method === "GET") {
      if (!viaGrant) return (o.googleError(res, 403, "PERMISSION_DENIED", "a grant only"), true);
      o.send(res, 200, { user: { emailAddress: api.accountEmail } });
      return true;
    }
    if (p === "/v4/spreadsheets" && req.method === "POST") {
      if (!viaGrant) return (o.googleError(res, 403, "PERMISSION_DENIED", "drive.file only"), true);
      const b = await body();
      const id = `made-${randomBytes(12).toString("base64url")}`;
      const s: MadeSpreadsheet = {
        id,
        title: String(b.properties?.title ?? "Untitled"),
        trashed: false,
        modified: o.tick(),
        tabs: ((b.sheets ?? []) as Req[]).map((x) => ({
          sheetId: nextSheetId++,
          title: String(x.properties?.title ?? "Sheet1"),
          frozen: Number(x.properties?.gridProperties?.frozenRowCount ?? 0),
          rows: [],
        })),
      };
      sheets.set(id, s);
      o.send(res, 200, {
        spreadsheetId: id,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
        sheets: s.tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title } })),
      });
      return true;
    }
    const m =
      /^\/v4\/spreadsheets\/(made-[^/:]+)(:batchUpdate|\/developerMetadata:search|\/values:batchGetByDataFilter)?$/.exec(
        p,
      );
    const drive = /^\/drive\/v3\/files\/(made-[^/]+)$/.exec(p);
    const id = decodeURIComponent((m ?? drive)?.[1] ?? "");
    if (!m && !drive) return false;
    const s = live(id);
    if (!s) return (o.googleError(res, 404, "NOT_FOUND", "Requested entity was not found."), true);
    if (drive) {
      if (req.method === "PATCH") {
        const b = await body();
        if (b.trashed === true) s.trashed = true;
        o.send(res, 200, { id, trashed: s.trashed });
      } else
        o.send(res, 200, {
          mimeType: "application/vnd.google-apps.spreadsheet",
          modifiedTime: new Date(s.modified).toISOString(),
          trashed: false,
        });
      return true;
    }
    if (m && !m[2]) {
      o.send(res, 200, {
        properties: { title: s.title },
        sheets: s.tabs.map((t) => ({
          properties: {
            sheetId: t.sheetId,
            title: t.title,
            gridProperties: {
              rowCount: Math.max(1000, t.rows.length),
              columnCount: Math.max(26, ...t.rows.map((r) => r.cells.length)),
            },
          },
        })),
      });
      return true;
    }
    if (p.endsWith(":batchUpdate")) {
      if (refuse !== null) {
        const status = refuse;
        refuse = null;
        o.googleError(res, status, status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE", "fake refused");
        return true;
      }
      const b = await body();
      const copy = structuredClone(s);
      try {
        const replies = ((b.requests ?? []) as Req[]).map((r) => apply(copy, r));
        Object.assign(s, copy, { modified: o.tick() });
        if (afterApply !== null) {
          const status = afterApply;
          afterApply = null;
          o.googleError(res, status, "UNAVAILABLE", "fake lost answer");
          return true;
        }
        o.send(res, 200, { spreadsheetId: id, replies });
      } catch (e) {
        o.googleError(res, 400, "INVALID_ARGUMENT", (e as Error).message);
      }
      return true;
    }
    if (p.endsWith("/developerMetadata:search")) {
      const matched = s.tabs.flatMap((t) =>
        t.rows.flatMap((r, i) =>
          r.lead === null
            ? []
            : [
                {
                  developerMetadata: {
                    metadataId: t.sheetId * 100000 + i,
                    metadataKey: "lume.lead",
                    metadataValue: r.lead,
                    location: {
                      locationType: "ROW",
                      dimensionRange: {
                        sheetId: t.sheetId,
                        dimension: "ROWS",
                        startIndex: i,
                        endIndex: i + 1,
                      },
                    },
                  },
                },
              ],
        ),
      );
      o.send(res, 200, matched.length ? { matchedDeveloperMetadata: matched } : {});
      return true;
    }
    // values:batchGetByDataFilter, one gridRange per tab.
    const b = await body();
    const valueRanges = ((b.dataFilters ?? []) as Req[]).map((f) => {
      const t = tabById(s, f.gridRange.sheetId);
      const rows = t.rows.map((r) => {
        const out = [...r.cells];
        while (out.length && out.at(-1) === "") out.pop();
        return out;
      });
      while (rows.length && rows.at(-1)!.length === 0) rows.pop();
      return { valueRange: { majorDimension: "ROWS", ...(rows.length ? { values: rows } : {}) } };
    });
    o.send(res, 200, { spreadsheetId: id, valueRanges });
    return true;
  }

  const api: MadeSheets = {
    accountEmail: "owner@business.test",
    get: (id) => sheets.get(id),
    all: () => [...sheets.values()],
    editCell(id, tab, row, col, value) {
      const r = sheets.get(id)!.tabs[tab]!.rows[row]!;
      fit(r, col + 1);
      r.cells[col] = value;
      r.kinds[col] = value === "" ? "empty" : "string";
      sheets.get(id)!.modified = o.tick();
    },
    insertByHand(id, tab, row, cells) {
      const r = blank(0);
      cells.forEach((c, i) => {
        fit(r, i + 1);
        r.cells[i] = c;
        r.kinds[i] = c === "" ? "empty" : "string";
      });
      sheets.get(id)!.tabs[tab]!.rows.splice(row, 0, r);
      sheets.get(id)!.modified = o.tick();
    },
    insertTagged(id, tab, row, lead, cells) {
      api.insertByHand(id, tab, row, cells);
      sheets.get(id)!.tabs[tab]!.rows[row]!.lead = lead;
    },
    deleteRow(id, tab, row) {
      sheets.get(id)!.tabs[tab]!.rows.splice(row, 1);
      sheets.get(id)!.modified = o.tick();
    },
    sort(id, tab, col, dir) {
      const t = sheets.get(id)!.tabs[tab]!;
      const [head, ...data] = t.rows;
      data.sort((a, b) => {
        const x = String(a.cells[col] ?? "");
        const y = String(b.cells[col] ?? "");
        const c = x.localeCompare(y, "en", { numeric: true });
        return dir === "asc" ? c : -c;
      });
      t.rows = head ? [head, ...data] : data;
      sheets.get(id)!.modified = o.tick();
    },
    removeFile(id) {
      sheets.delete(id);
    },
    failNextBatch(status) {
      refuse = status;
    },
    failAfterApply(status) {
      afterApply = status;
    },
    reset() {
      sheets.clear();
      refuse = null;
      afterApply = null;
    },
  };
  return { handle, api };
}
