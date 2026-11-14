import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SheetRow } from "@lume/core";
import { startGoogleFake, type GoogleFake } from "../../../test/google-fake";
import { GoogleError } from "../sheets/google";
import { liveSheetsGoogle, type LiveSheetsGoogle, type MadeSheet } from "./google";

let fake: GoogleFake;
let g: LiveSheetsGoogle;
const slept: number[] = [];

beforeAll(async () => {
  fake = await startGoogleFake();
});
afterAll(async () => fake.close());
beforeEach(() => {
  slept.length = 0;
  g = liveSheetsGoogle({
    tokens: async () => {
      const r = await fetch(`${fake.url}/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt-good" }),
      });
      return ((await r.json()) as { access_token: string }).access_token;
    },
    endpoint: fake.url,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
});

const HEADER = ["email", "phone", "fn", "ln", "country"];
const make = () =>
  g.create({
    title: "Qualified leads",
    header: HEADER,
    about: { markUrl: "https://x.test/lume-mark.png", lines: ["Kept up to date by LUME · lumecrm.in"] },
  });
const leads = (n: number, from = 0): SheetRow[] =>
  Array.from({ length: n }, (_, i) => ({
    leadId: `lead-${from + i}`,
    cells: [
      `l${from + i}@x.test`,
      `9198000${String(from + i).padStart(5, "0")}`,
      `Lead`,
      `${from + i}`,
      "IN",
    ],
  }));
const tab = (s: MadeSheet) => fake.made.get(s.spreadsheetId)!.tabs[0]!;

describe("live sheets in Google", () => {
  it("makes the sheet: a clean first tab with LUME's header, and the Made with LUME tab with the mark", async () => {
    const s = await make();
    expect(s.url).toBe(`https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit`);
    const made = fake.made.get(s.spreadsheetId)!;
    expect(made.title).toBe("Qualified leads");
    expect(made.tabs.map((t) => t.title)).toEqual(["Qualified leads", "Made with LUME"]);
    const first = made.tabs[0]!;
    expect(first.frozen).toBe(1);
    expect(first.rows[0]!.cells).toEqual(HEADER);
    expect(first.rows[0]!.bg).toEqual(HEADER.map(() => "#2a5bff"));
    expect(first.rows[0]!.bold).toBe(true);
    const about = made.tabs[1]!;
    expect(about.rows[0]!.cells[0]).toBe('=IMAGE("https://x.test/lume-mark.png")');
    expect(about.rows.map((r) => r.cells[0])).toContain("Kept up to date by LUME · lumecrm.in");
  });

  it("writes new leads under the header in batches of 500, newest first, each row tagged with its lead", async () => {
    const s = await make();
    const done: number[] = [];
    await g.write(s, { add: leads(1200), update: [], remove: [] }, async (n) => {
      done.push(n);
    });
    expect(done).toEqual([500, 1000, 1200]);
    const rows = tab(s).rows;
    expect(rows).toHaveLength(1201);
    expect(rows[1]!.lead).toBe("lead-0");
    expect(rows[1200]!.lead).toBe("lead-1199");
    expect(fake.calls.filter((c) => c.endsWith(":batchUpdate")).length).toBeGreaterThanOrEqual(3);
  });

  it("an empty value is an empty cell, shaded; a value starting with = stays words, never a formula", async () => {
    const s = await make();
    await g.write(
      s,
      { add: [{ leadId: "x", cells: ["=HYPERLINK(1)", null, "Riya", "", "IN"] }], update: [], remove: [] },
      async () => {},
    );
    const r = tab(s).rows[1]!;
    expect(r.cells).toEqual(["=HYPERLINK(1)", "", "Riya", "", "IN"]);
    expect(r.kinds[0]).toBe("string");
    expect(r.bg).toEqual([null, "#eef1f6", null, "#eef1f6", null]);
  });

  it("finds a lead's row by its tag after a person sorts the sheet, and updates only the cells it's told", async () => {
    const s = await make();
    await g.write(s, { add: leads(3), update: [], remove: [] }, async () => {});
    fake.made.sort(s.spreadsheetId, 0, 3, "desc"); // by ln: lead-2 first now
    await g.write(
      s,
      {
        add: [],
        update: [
          { leadId: "lead-0", cells: ["new@x.test", "919800000000", "Neo", "0", "AE"], skipCols: [2] },
        ],
        remove: [],
      },
      async () => {},
    );
    const row = tab(s).rows.find((r) => r.lead === "lead-0")!;
    expect(row.cells).toEqual(["new@x.test", "919800000000", "Lead", "0", "AE"]);
    expect(tab(s).rows[1]!.lead).toBe("lead-2");
  });

  it("removes the right rows after a sort, and leaves rows a person typed in", async () => {
    const s = await make();
    await g.write(s, { add: leads(4), update: [], remove: [] }, async () => {});
    fake.made.insertByHand(s.spreadsheetId, 0, 2, ["mine@x.test", "", "My", "own", ""]);
    fake.made.sort(s.spreadsheetId, 0, 3, "desc");
    await g.write(s, { add: [], update: [], remove: ["lead-1", "lead-3"] }, async () => {});
    expect(tab(s).rows).toHaveLength(4); // the header, two leads and the person's own row
    const leadsLeft = tab(s)
      .rows.map((r) => r.lead)
      .filter(Boolean);
    expect(leadsLeft.sort()).toEqual(["lead-0", "lead-2"]);
    expect(tab(s).rows.some((r) => r.cells[0] === "mine@x.test")).toBe(true);
  });

  it("Google too busy: waits and tries again, and every lead is written exactly once", async () => {
    const s = await make();
    fake.made.failNextBatch(429);
    const done: number[] = [];
    await g.write(s, { add: leads(1300), update: [], remove: [] }, async (n) => {
      done.push(n);
    });
    expect(done).toEqual([500, 1000, 1300]);
    const ids = tab(s)
      .rows.slice(1)
      .map((r) => r.lead);
    expect(ids).toHaveLength(1300);
    expect(new Set(ids).size).toBe(1300);
    expect(slept.length).toBeGreaterThan(0);
  });

  it("a lost answer after Google wrote the batch: LUME checks the tags and doesn't write it twice", async () => {
    const s = await make();
    fake.made.failAfterApply(503);
    await g.write(s, { add: leads(600), update: [], remove: [] }, async () => {});
    const ids = tab(s)
      .rows.slice(1)
      .map((r) => r.lead);
    expect(ids).toHaveLength(600);
    expect(new Set(ids).size).toBe(600);
  });

  it("reads the tab back: each row's lead (by tag), its cells as stored, and rows a person added", async () => {
    const s = await make();
    await g.write(s, { add: leads(2), update: [], remove: [] }, async () => {});
    fake.made.editCell(s.spreadsheetId, 0, 1, 2, "Edited");
    fake.made.insertByHand(s.spreadsheetId, 0, 3, ["x@x.test"]);
    const read = await g.readTab(s);
    expect(read.rows.map((r) => r.leadId)).toEqual(["lead-0", "lead-1", null]);
    expect(read.rows[0]!.cells[2]).toBe("Edited");
    expect(read.modifiedTime).toMatch(/^\d{4}-/);
  });

  it("renames the sheet and its first tab, rewrites the header, and moves it to Google's bin", async () => {
    const s = await make();
    await g.rename(s, "Won clients");
    await g.setHeader(s, ["email", "phone", "fn", "ln", "country", "value"]);
    const made = fake.made.get(s.spreadsheetId)!;
    expect(made.title).toBe("Won clients");
    expect(made.tabs[0]!.title).toBe("Won clients");
    expect(made.tabs[0]!.rows[0]!.cells).toHaveLength(6);
    await g.trash(s.spreadsheetId);
    expect(fake.made.get(s.spreadsheetId)!.trashed).toBe(true);
  });

  it("a sheet the person deleted in Google is not_found", async () => {
    const s = await make();
    fake.made.removeFile(s.spreadsheetId);
    await expect(g.readTab(s)).rejects.toMatchObject({ kind: "not_found" });
    await expect(g.readTab(s)).rejects.toBeInstanceOf(GoogleError);
  });
});
