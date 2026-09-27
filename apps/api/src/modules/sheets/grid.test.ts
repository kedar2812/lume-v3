import { describe, expect, it } from "vitest";
import { readCsv, type Mapping } from "@lume/core";
import { anchorHash, gridToCsv, headerDrift, isBlank, sheetFingerprint, toRows } from "./grid";

const mapping: Mapping = {
  columns: [
    { column: 0, to: "field", field: "lead_created_at" },
    { column: 1, to: "field", field: "name" },
    { column: 2, to: "field", field: "phone" },
    { column: 3, to: "ignore" },
  ],
  createMissingTags: false,
};

describe("toRows (Review Focus 1)", () => {
  it("pads short rows, cuts long ones, skips blank rows but keeps every row's own number", () => {
    const rows = toRows([["a", "b"], [], ["", "  "], ["c"], ["d", "e", "f", "g"]], 5, 3);
    expect(rows).toEqual([
      { number: 5, cells: ["a", "b", ""] },
      { number: 8, cells: ["c", "", ""] },
      { number: 9, cells: ["d", "e", "f"] },
    ]);
    expect(isBlank(["", " "])).toBe(true);
  });
});

describe("headerDrift (Review Focus 4)", () => {
  const saved = ["Timestamp", "Full name", "Phone", "Notes"];
  it("case and spacing aren't a rename", () => {
    expect(headerDrift(saved, [" timestamp", "FULL  NAME", "phone ", "Notes"], mapping)).toEqual({
      broken: [],
      added: [],
    });
  });
  it("a mapped column renamed or removed is broken; an ignored one renamed is not", () => {
    expect(headerDrift(saved, ["Timestamp", "Name", "Phone", "Remarks"], mapping)).toEqual({
      broken: [{ column: 1, was: "Full name", now: "Name" }],
      added: [],
    });
    expect(headerDrift(saved, ["Timestamp", "Full name"], mapping).broken).toEqual([
      { column: 2, was: "Phone", now: null },
    ]);
  });
  it("a column inserted before mapped ones shifts them: broken, never guessed", () => {
    expect(
      headerDrift(saved, ["Timestamp", "Source", "Full name", "Phone", "Notes"], mapping).broken[0],
    ).toEqual({
      column: 1,
      was: "Full name",
      now: "Source",
    });
  });
  it("new columns at the end are offered, not broken", () => {
    expect(headerDrift(saved, [...saved, "Budget", ""], mapping)).toEqual({ broken: [], added: ["Budget"] });
  });
});

describe("recognising rows", () => {
  it("a row's fingerprint is its raw date cell plus its contact cells, so a later enquiry is a new row", () => {
    const a = sheetFingerprint(["27/09/2026 10:15:02", "Aisha Khan", "0501234567", ""], mapping);
    const edited = sheetFingerprint(["27/09/2026 10:15:02", "A. Khan", " 0501234567 ", "note"], mapping);
    const later = sheetFingerprint(["27/09/2026 18:40:11", "Aisha Khan", "0501234567", ""], mapping);
    expect(edited).toBe(a); // an edited name or an unmapped note doesn't make it a new enquiry
    expect(later).not.toBe(a);
  });
  it("a row with no date or contact filled is recognised by all its cells", () => {
    const x = sheetFingerprint(["", "Only a name", "", "n"], mapping);
    expect(sheetFingerprint(["", " Only a name ", "", "n"], mapping)).toBe(x);
    expect(sheetFingerprint(["", "Another name", "", "n"], mapping)).not.toBe(x);
  });
  it("the anchor changes when the header, the first row or the last row read changes", () => {
    const base = anchorHash(["Name"], ["A"], ["Z"]);
    expect(anchorHash(["Name"], ["A"], ["Z"])).toBe(base);
    expect(anchorHash(["Name"], ["B"], ["Z"])).not.toBe(base);
    expect(anchorHash(["Name"], ["A"], ["Y"])).not.toBe(base);
    expect(anchorHash(["Name"], ["A"], undefined)).not.toBe(base);
  });
});

describe("gridToCsv", () => {
  it("round-trips through the 2A reader with row numbers intact (blank rows, quotes and line breaks included)", () => {
    const csv = gridToCsv([
      ["Name", "Note"],
      ["Aisha", 'said "hi", then left'],
      [],
      ["Omar", "line one\nline two"],
    ]);
    const r = readCsv(new TextEncoder().encode(csv), { headerRow: 1 });
    if (!r.ok) throw new Error(r.message);
    expect(r.headers).toEqual(["Name", "Note"]);
    expect(r.rows).toEqual([
      ["Aisha", 'said "hi", then left'],
      ["", ""],
      ["Omar", "line one\nline two"],
    ]);
    expect(r.rowNumbers).toEqual([2, 3, 4]);
  });
});
