import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { readSheets } from "./sheet";

/** A workbook made here by SheetJS itself, as Excel would save it. */
function workbook(sheets: Record<string, (string | number)[][]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("reading a spreadsheet for LUME's viewer (plan 2026-10-20-media-tab, Task 8)", () => {
  it("every sheet by name, its first row as the header, numbers marked to sit on the right", () => {
    const sheets = readSheets(
      workbook({
        Homes: [
          ["Package", "Price"],
          ["Design consult", 2500],
          ["Home, 2 BHK", 380000],
        ],
        Offices: [["Package"], ["Per sq ft"]],
      }),
    );
    expect(sheets.map((s) => s.name)).toEqual(["Homes", "Offices"]);
    expect(sheets[0]!.header).toEqual(["Package", "Price"]);
    expect(sheets[0]!.rows).toEqual([
      ["Design consult", "2500"],
      ["Home, 2 BHK", "380000"],
    ]);
    expect(sheets[0]!.numeric).toEqual([false, true]);
    expect(sheets[0]!.total).toBe(2);
  });

  it("a huge sheet: only the first 2,000 rows are read, and how many there are is known", () => {
    const rows: (string | number)[][] = [["Lead", "Value"]];
    for (let i = 1; i <= 12_431; i++) rows.push([`Lead ${i}`, i]);
    const [s] = readSheets(workbook({ Leads: rows }));
    expect(s!.rows).toHaveLength(2000);
    expect(s!.total).toBe(12_431);
    expect(s!.rows.at(-1)).toEqual(["Lead 2000", "2000"]);
  });

  it("an empty sheet is still a tab, with nothing in it", () => {
    const [s] = readSheets(workbook({ Blank: [] }));
    expect(s).toMatchObject({ name: "Blank", header: [], rows: [], total: 0 });
  });

  it("what isn't a spreadsheet is refused, not guessed at", () => {
    expect(() =>
      readSheets(new TextEncoder().encode("<html><script>alert(1)</script></html>").buffer),
    ).toThrow();
  });
});
