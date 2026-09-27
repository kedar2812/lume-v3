import { describe, expect, it } from "vitest";
import { INTAKE_LIMITS } from "./limits";
import { columnLetter, readCsv } from "./read";

const utf8 = (s: string) => new TextEncoder().encode(s);
const ok = (r: ReturnType<typeof readCsv>) => {
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  return r;
};

describe("readCsv: encodings", () => {
  it("reads UTF-8, with or without a BOM", () => {
    const r = ok(readCsv(utf8("﻿Name,Phone\nAïsha,0501234567\n")));
    expect(r.encoding).toBe("utf-8");
    expect(r.headers).toEqual(["Name", "Phone"]);
    expect(r.rows).toEqual([["Aïsha", "0501234567"]]);
    expect(ok(readCsv(utf8("Name,Phone\nAïsha,0501234567\n"))).headers).toEqual(["Name", "Phone"]);
  });

  it("reads UTF-16 LE and BE from their BOMs (Excel's 'Unicode text')", () => {
    const le = Buffer.from("﻿Name\tCity\nZoë\tDubai\n", "utf16le");
    const r = ok(readCsv(new Uint8Array(le)));
    expect(r.encoding).toBe("utf-16le");
    expect(r.delimiter).toBe("\t");
    expect(r.rows[0]).toEqual(["Zoë", "Dubai"]);
    const be = Buffer.from(le).swap16();
    const rb = ok(readCsv(new Uint8Array(be)));
    expect(rb.encoding).toBe("utf-16be");
    expect(rb.rows[0]).toEqual(["Zoë", "Dubai"]);
  });

  it("falls back to Windows-1252 with a warning when the bytes aren't UTF-8", () => {
    const bytes = new Uint8Array([...utf8("Name\nCaf"), 0xe9, ...utf8("\n")]);
    const r = ok(readCsv(bytes));
    expect(r.encoding).toBe("windows-1252");
    expect(r.rows[0]).toEqual(["Café"]);
    expect(r.fileWarnings.map((w) => w.code)).toContain("ENCODING_GUESSED");
  });

  it("obeys an encoding override", () => {
    const bytes = new Uint8Array([...utf8("Name\nCaf"), 0xe9, ...utf8("\n")]);
    const r = ok(readCsv(bytes, { encoding: "windows-1252" }));
    expect(r.rows[0]).toEqual(["Café"]);
    expect(r.fileWarnings).toEqual([]);
  });
});

describe("readCsv: delimiters and quoting", () => {
  it.each([
    [",", "Name,Phone,City\nA,1,X\nB,2,Y\n"],
    [";", "Name;Amount;Date\nA;1.234,50;04.03.2026\nB;99,00;05.03.2026\n"],
    ["\t", "Name\tPhone\nA\t1\n"],
    ["|", "Name|Phone\nA|1\nB|2\n"],
  ])("detects %j", (d, text) => {
    expect(ok(readCsv(utf8(text))).delimiter).toBe(d);
  });

  it("keeps commas, quotes and line breaks inside quoted cells, and every line ending", () => {
    const r = ok(readCsv(utf8('Name,Note\r\n"Khan, Aisha","Said ""call me""\nafter 6"\rB,x\n')));
    expect(r.rows).toEqual([
      ["Khan, Aisha", 'Said "call me"\nafter 6'],
      ["B", "x"],
    ]);
  });

  it("treats a one-column file as comma-delimited", () => {
    expect(ok(readCsv(utf8("Name\nA\nB\n"))).delimiter).toBe(",");
  });

  it("obeys a delimiter override", () => {
    const r = ok(readCsv(utf8("a;b,c\n1;2,3\n"), { delimiter: ";" }));
    expect(r.headers).toEqual(["a", "b,c"]);
  });
});

describe("readCsv: the header row", () => {
  it("skips a title line and blank lines above the real header", () => {
    const r = ok(readCsv(utf8("Leads export — March\n\nName,Phone,Email\nA,1,a@x.com\n")));
    expect(r.headerRow).toBe(3);
    expect(r.headers).toEqual(["Name", "Phone", "Email"]);
    expect(r.rowNumbers).toEqual([4]);
  });

  it("uses a chosen header row", () => {
    const r = ok(readCsv(utf8("x,y\nName,Phone\nA,1\n"), { headerRow: 2 }));
    expect(r.headers).toEqual(["Name", "Phone"]);
    expect(r.rows).toEqual([["A", "1"]]);
  });

  it("names blank headers by column letter and numbers repeated ones", () => {
    const r = ok(readCsv(utf8("Phone,,Phone, Phone \n1,2,3,4\n")));
    expect(r.headers).toEqual(["Phone", "Column B", "Phone (2)", "Phone (3)"]);
  });
});

describe("readCsv: rows", () => {
  it("drops trailing empty rows, pads short rows and warns about long ones", () => {
    const r = ok(readCsv(utf8("A,B,C\n1,2\n1,2,3,4\n,,\n\n")));
    expect(r.rows).toEqual([
      ["1", "2", ""],
      ["1", "2", "3", "4"],
    ]);
    expect(r.fileWarnings.map((w) => w.code)).toContain("RAGGED_ROWS");
  });

  it("keeps an empty row in the middle (it's reported as an empty row later)", () => {
    const r = ok(readCsv(utf8("A,B\n1,2\n,\n3,4\n")));
    expect(r.rows).toHaveLength(3);
    expect(r.rowNumbers).toEqual([2, 3, 4]);
  });
});

describe("readCsv: refusals", () => {
  it.each([
    ["an empty file", "", "FILE_EMPTY"],
    ["whitespace only", " \n \n", "FILE_EMPTY"],
    ["a header with no rows", "Name,Phone\n\n", "FILE_EMPTY"],
  ])("refuses %s", (_what, text, code) => {
    expect(readCsv(utf8(text))).toMatchObject({ ok: false, code });
  });

  it("refuses Excel files by content or name, saying how to save as CSV", () => {
    const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    expect(readCsv(xlsx)).toMatchObject({ ok: false, code: "NOT_CSV_EXCEL" });
    expect(readCsv(utf8("a,b\n1,2"), { fileName: "leads.XLSX" })).toMatchObject({
      ok: false,
      code: "NOT_CSV_EXCEL",
    });
    const r = readCsv(xlsx);
    expect(!r.ok && r.message).toMatch(/Save as → CSV UTF-8/);
  });

  it("refuses binary content", () => {
    expect(readCsv(new Uint8Array([0x00, 0x01, 0x02, 0x41, 0x00]))).toMatchObject({
      ok: false,
      code: "NOT_TEXT",
    });
  });

  it("refuses too many columns, rows or bytes", () => {
    const wide = `${Array.from({ length: 201 }, (_, i) => `c${i}`).join(",")}\n${"1,".repeat(200)}1\n`;
    expect(readCsv(utf8(wide))).toMatchObject({ ok: false, code: "TOO_MANY_COLUMNS" });
    const tall = `Name\n${"x\n".repeat(INTAKE_LIMITS.rows + 1)}`;
    expect(readCsv(utf8(tall))).toMatchObject({ ok: false, code: "TOO_MANY_ROWS" });
    expect(readCsv(new Uint8Array(INTAKE_LIMITS.bytes + 1).fill(0x41))).toMatchObject({
      ok: false,
      code: "FILE_TOO_BIG",
    });
  });

  it("accepts exactly the row limit", () => {
    const r = ok(readCsv(utf8(`Name\n${"x\n".repeat(INTAKE_LIMITS.rows)}`)));
    expect(r.rows).toHaveLength(INTAKE_LIMITS.rows);
  });
});

describe("columnLetter", () => {
  it.each([
    [0, "A"],
    [25, "Z"],
    [26, "AA"],
    [701, "ZZ"],
    [702, "AAA"],
  ])("%i → %s", (i, l) => expect(columnLetter(i)).toBe(l));
  it("a header with no rows is refused, unless the caller allows it (a new form sheet, 2B)", () => {
    const bytes = new TextEncoder().encode("Name,Phone\n");
    expect(readCsv(bytes)).toMatchObject({ ok: false, code: "FILE_EMPTY" });
    expect(readCsv(bytes, { allowNoRows: true })).toMatchObject({
      ok: true,
      headers: ["Name", "Phone"],
      rows: [],
    });
  });
});
