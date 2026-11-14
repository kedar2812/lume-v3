import { cellText, type SheetCell, type SheetRow } from "@lume/core";
import { GoogleError, googleCaller, type TokenSource } from "../sheets/google";

/**
 * Live sheets in Google (spec 2026-11-14 §3): the spreadsheets LUME makes with drive.file, and every write to them.
 *
 * Each of LUME's rows carries developer metadata `lume.lead` = the lead's id, which moves with the row when people
 * sort, filter or insert rows, and never shows in the sheet or its CSV. Every step of a write first reads those tags
 * fresh, so a row is always found where it is now, a batch Google already applied (its answer lost) is never applied
 * twice, and a lead that somehow has two rows is put back to one.
 */
export type MadeSheet = { spreadsheetId: string; url: string; tabId: number };
export type TabRow = { leadId: string | null; cells: string[] };
/** The first tab's data rows (under the header), in the sheet's order. */
export type TabRead = { rows: TabRow[]; modifiedTime: string };
export type WritePlanForGoogle = {
  add: SheetRow[];
  update: { leadId: string; cells: SheetCell[]; skipCols: number[] }[];
  remove: string[];
};
export type LiveSheetsGoogle = {
  create(o: {
    title: string;
    header: string[];
    about: { markUrl: string; lines: string[] };
  }): Promise<MadeSheet>;
  readTab(s: MadeSheet): Promise<TabRead>;
  /** `onBatch(done)` after each batch Google confirmed: rows removed, updated and added so far. */
  write(s: MadeSheet, plan: WritePlanForGoogle, onBatch: (done: number) => Promise<void>): Promise<void>;
  setHeader(s: MadeSheet, header: string[]): Promise<void>;
  /** The Made with LUME tab's lines under the mark; a tab the person removed or renamed is left alone. */
  setAbout(s: MadeSheet, lines: string[]): Promise<void>;
  rename(s: MadeSheet, title: string): Promise<void>;
  file(spreadsheetId: string): Promise<{ modifiedTime: string; trashed: boolean }>;
  trash(spreadsheetId: string): Promise<void>;
};

export const ABOUT_TAB = "Made with LUME";
const KEY = "lume.lead";
/** Rows a request carries at most. */
export const BATCH_ROWS = 500;
const rgb = (hex: string) => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
});
/** LUME's accent, the header's fill. */
const HEADER_BG = rgb("#2A5BFF");
/** An empty value's fill: shaded, so a missing detail shows; it never reaches a CSV. */
const EMPTY_BG = rgb("#EEF1F6");
const WHITE = rgb("#FFFFFF");
/** Waits after Google says it's too busy, then a give-up. */
const RATE_WAITS = [2000, 4000, 8000, 16000, 32000, 60000, 60000];
/** Tries when Google's answer was lost (it may have applied the batch): each starts from fresh tags. */
const LOST_TRIES = 4;

const CELL_FIELDS = "userEnteredValue,userEnteredFormat.backgroundColor";

/** A value as Google stores it: words stay words (a phone, or text starting with =), numbers stay numbers. */
function cell(v: SheetCell) {
  const text = typeof v === "number" ? null : cellText(v);
  if (typeof v === "number" && Number.isFinite(v)) return { userEnteredValue: { numberValue: v } };
  if (!text) return { userEnteredFormat: { backgroundColor: EMPTY_BG } };
  return { userEnteredValue: { stringValue: text } };
}
const headerCell = (h: string) => ({
  userEnteredValue: { stringValue: h },
  userEnteredFormat: { backgroundColor: HEADER_BG, textFormat: { bold: true, foregroundColor: WHITE } },
});

export function liveSheetsGoogle(o: {
  tokens: TokenSource;
  endpoint?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): LiveSheetsGoogle {
  const sheetsBase = o.endpoint ?? "https://sheets.googleapis.com";
  const driveBase = o.endpoint ?? "https://www.googleapis.com";
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const call = googleCaller({
    tokens: o.tokens,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });
  const enc = encodeURIComponent;
  const ss = (id: string) => `${sheetsBase}/v4/spreadsheets/${enc(id)}`;

  /** One batchUpdate, once: Google applies all of it or none. */
  const batch = (id: string, requests: unknown[]) =>
    call<unknown>(`${ss(id)}:batchUpdate`, { method: "POST", body: { requests }, retry: false });

  /** A step that reads fresh tags and writes: waits out "too busy", and starts again from fresh tags when an answer is lost. */
  async function step(run: () => Promise<void>): Promise<void> {
    let rate = 0;
    let lost = 0;
    for (;;) {
      try {
        return await run();
      } catch (e) {
        if (!(e instanceof GoogleError)) throw e;
        if (e.kind === "rate" && rate < RATE_WAITS.length) {
          await sleep(RATE_WAITS[rate++]!);
          continue;
        }
        if (e.kind === "unavailable" && lost < LOST_TRIES) {
          lost++;
          await sleep(1000 * lost);
          continue;
        }
        throw e;
      }
    }
  }

  /** Each lead's tagged rows on the tab (0-based grid rows, the header is 0), in order. */
  async function tags(s: MadeSheet): Promise<Map<string, number[]>> {
    const j = await call<{
      matchedDeveloperMetadata?: {
        developerMetadata: {
          metadataValue?: string;
          location?: { dimensionRange?: { sheetId: number; startIndex: number } };
        };
      }[];
    }>(`${ss(s.spreadsheetId)}/developerMetadata:search`, {
      method: "POST",
      body: { dataFilters: [{ developerMetadataLookup: { metadataKey: KEY, locationType: "ROW" } }] },
    });
    const out = new Map<string, number[]>();
    for (const m of j.matchedDeveloperMetadata ?? []) {
      const d = m.developerMetadata.location?.dimensionRange;
      const lead = m.developerMetadata.metadataValue;
      if (!d || d.sheetId !== s.tabId || !lead || d.startIndex < 1) continue;
      out.set(
        lead,
        [...(out.get(lead) ?? []), d.startIndex].sort((a, b) => a - b),
      );
    }
    return out;
  }

  /** Delete these grid rows, bottom up, contiguous runs merged. */
  const deletions = (s: MadeSheet, rows: number[]) => {
    const sorted = [...new Set(rows)].sort((a, b) => b - a);
    const out: unknown[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const end = sorted[i]! + 1;
      let start = sorted[i]!;
      while (sorted[i + 1] === start - 1) start = sorted[++i]!;
      out.push({
        deleteDimension: { range: { sheetId: s.tabId, dimension: "ROWS", startIndex: start, endIndex: end } },
      });
    }
    return out;
  };

  async function file(spreadsheetId: string) {
    const j = await call<{ modifiedTime: string; trashed?: boolean }>(
      `${driveBase}/drive/v3/files/${enc(spreadsheetId)}?fields=${enc("modifiedTime,trashed")}`,
    );
    return { modifiedTime: j.modifiedTime, trashed: j.trashed === true };
  }

  return {
    file,
    async create(c) {
      const made = await call<{
        spreadsheetId: string;
        spreadsheetUrl: string;
        sheets: { properties: { sheetId: number; title: string } }[];
      }>(`${sheetsBase}/v4/spreadsheets`, {
        method: "POST",
        retry: false,
        body: {
          properties: { title: c.title },
          sheets: [
            {
              properties: {
                title: c.title,
                gridProperties: { frozenRowCount: 1, columnCount: Math.max(26, c.header.length) },
              },
            },
            { properties: { title: ABOUT_TAB } },
          ],
        },
      });
      const [first, about] = made.sheets;
      const s: MadeSheet = {
        spreadsheetId: made.spreadsheetId,
        url: made.spreadsheetUrl,
        tabId: first!.properties.sheetId,
      };
      const aboutId = about!.properties.sheetId;
      // Setting cells is the same however often it lands: Google may be retried.
      await step(() =>
        batch(s.spreadsheetId, [
          {
            updateCells: {
              start: { sheetId: s.tabId, rowIndex: 0, columnIndex: 0 },
              rows: [{ values: c.header.map(headerCell) }],
              fields: "userEnteredValue,userEnteredFormat(backgroundColor,textFormat)",
            },
          },
          {
            updateCells: {
              start: { sheetId: aboutId, rowIndex: 0, columnIndex: 0 },
              rows: [
                {
                  values: [
                    { userEnteredValue: { formulaValue: `=IMAGE("${c.about.markUrl.replace(/"/g, "")}")` } },
                  ],
                },
                { values: [{}] },
                ...c.about.lines.map((l) => ({
                  values: [{ userEnteredValue: { stringValue: cellText(l) } }],
                })),
              ],
              fields: "userEnteredValue",
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: aboutId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
              properties: { pixelSize: 96 },
              fields: "pixelSize",
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: aboutId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
              properties: { pixelSize: 420 },
              fields: "pixelSize",
            },
          },
        ]).then(() => undefined),
      );
      return s;
    },

    async readTab(s) {
      const [tagged, values, f] = await Promise.all([
        tags(s),
        call<{ valueRanges?: { valueRange?: { values?: unknown[][] } }[] }>(
          `${ss(s.spreadsheetId)}/values:batchGetByDataFilter`,
          {
            method: "POST",
            body: {
              dataFilters: [{ gridRange: { sheetId: s.tabId } }],
              majorDimension: "ROWS",
              valueRenderOption: "UNFORMATTED_VALUE",
            },
          },
        ),
        file(s.spreadsheetId),
      ]);
      const leadAt = new Map<number, string>();
      for (const [lead, rows] of tagged) leadAt.set(rows[0]!, lead);
      const grid = values.valueRanges?.[0]?.valueRange?.values ?? [];
      const last = Math.max(grid.length - 1, ...leadAt.keys(), 0);
      const rows: TabRow[] = [];
      for (let i = 1; i <= last; i++)
        rows.push({
          leadId: leadAt.get(i) ?? null,
          cells: (grid[i] ?? []).map((v) => (v == null ? "" : String(v))),
        });
      return { rows, modifiedTime: f.modifiedTime };
    },

    async write(s, plan, onBatch) {
      let done = 0;
      const id = s.spreadsheetId;
      // 1. Rows that leave, and any second row of one lead.
      if (plan.remove.length)
        await step(async () => {
          const t = await tags(s);
          const gone = new Set(plan.remove);
          const rows = [...t].flatMap(([lead, at]) => (gone.has(lead) ? at : at.slice(1)));
          const reqs = deletions(s, rows);
          for (let i = 0; i < reqs.length; i += BATCH_ROWS) await batch(id, reqs.slice(i, i + BATCH_ROWS));
        });
      done += plan.remove.length;
      if (plan.remove.length) await onBatch(done);

      // 2. Changed leads, where their rows are now; cells a person edited are skipped when asked.
      for (let i = 0; i < plan.update.length; i += BATCH_ROWS) {
        const chunk = plan.update.slice(i, i + BATCH_ROWS);
        await step(async () => {
          const t = await tags(s);
          const reqs: unknown[] = [];
          for (const u of chunk) {
            const at = t.get(u.leadId)?.[0];
            if (at === undefined) continue;
            const skip = new Set(u.skipCols);
            // One request per run of columns LUME writes, so a skipped cell is never touched.
            let j = 0;
            while (j < u.cells.length) {
              if (skip.has(j)) {
                j++;
                continue;
              }
              const from = j;
              const values = [];
              while (j < u.cells.length && !skip.has(j)) values.push(cell(u.cells[j++]!));
              reqs.push({
                updateCells: {
                  start: { sheetId: s.tabId, rowIndex: at, columnIndex: from },
                  rows: [{ values }],
                  fields: CELL_FIELDS,
                },
              });
            }
          }
          if (reqs.length) await batch(id, reqs);
        });
        done += chunk.length;
        await onBatch(done);
      }

      // 3. New leads under the header, in the order given (newest first); a batch already there is skipped.
      for (let i = 0; i < plan.add.length; i += BATCH_ROWS) {
        const chunk = plan.add.slice(i, i + BATCH_ROWS);
        await step(async () => {
          const t = await tags(s);
          const fresh = chunk.filter((r) => !t.has(r.leadId));
          if (!fresh.length) return;
          const before = plan.add.slice(0, i).filter((r) => t.has(r.leadId)).length;
          const at = 1 + before;
          await batch(id, [
            {
              insertDimension: {
                range: { sheetId: s.tabId, dimension: "ROWS", startIndex: at, endIndex: at + fresh.length },
                inheritFromBefore: false,
              },
            },
            {
              updateCells: {
                start: { sheetId: s.tabId, rowIndex: at, columnIndex: 0 },
                rows: fresh.map((r) => ({ values: r.cells.map(cell) })),
                fields: CELL_FIELDS,
              },
            },
            ...fresh.map((r, k) => ({
              createDeveloperMetadata: {
                developerMetadata: {
                  metadataKey: KEY,
                  metadataValue: r.leadId,
                  location: {
                    dimensionRange: {
                      sheetId: s.tabId,
                      dimension: "ROWS",
                      startIndex: at + k,
                      endIndex: at + k + 1,
                    },
                  },
                  visibility: "DOCUMENT",
                },
              },
            })),
          ]);
        });
        done += chunk.length;
        await onBatch(done);
      }
    },

    async setHeader(s, header) {
      const meta = await call<{
        sheets: { properties: { sheetId: number; gridProperties?: { columnCount?: number } } }[];
      }>(`${ss(s.spreadsheetId)}?fields=${enc("sheets.properties(sheetId,gridProperties.columnCount)")}`);
      const cols =
        meta.sheets.find((x) => x.properties.sheetId === s.tabId)?.properties.gridProperties?.columnCount ??
        26;
      await step(() =>
        batch(s.spreadsheetId, [
          ...(header.length > cols
            ? [
                {
                  updateSheetProperties: {
                    properties: { sheetId: s.tabId, gridProperties: { columnCount: header.length } },
                    fields: "gridProperties.columnCount",
                  },
                },
              ]
            : []),
          {
            updateCells: {
              start: { sheetId: s.tabId, rowIndex: 0, columnIndex: 0 },
              rows: [{ values: header.map(headerCell) }],
              fields: "userEnteredValue,userEnteredFormat(backgroundColor,textFormat)",
            },
          },
        ]).then(() => undefined),
      );
    },

    async setAbout(s, lines) {
      const meta = await call<{ sheets: { properties: { sheetId: number; title: string } }[] }>(
        `${ss(s.spreadsheetId)}?fields=${enc("sheets.properties(sheetId,title)")}`,
      );
      const about = meta.sheets.find((x) => x.properties.title === ABOUT_TAB);
      if (!about) return;
      await step(() =>
        batch(s.spreadsheetId, [
          {
            updateCells: {
              start: { sheetId: about.properties.sheetId, rowIndex: 2, columnIndex: 0 },
              rows: [...lines, "", "", ""].map((l) => ({
                values: [l ? { userEnteredValue: { stringValue: cellText(l) } } : {}],
              })),
              fields: "userEnteredValue",
            },
          },
        ]).then(() => undefined),
      );
    },

    async rename(s, title) {
      await step(() =>
        batch(s.spreadsheetId, [
          { updateSpreadsheetProperties: { properties: { title }, fields: "title" } },
          { updateSheetProperties: { properties: { sheetId: s.tabId, title }, fields: "title" } },
        ]).then(() => undefined),
      );
    },

    async trash(spreadsheetId) {
      await call(`${driveBase}/drive/v3/files/${enc(spreadsheetId)}`, {
        method: "PATCH",
        body: { trashed: true },
      });
    },
  };
}
