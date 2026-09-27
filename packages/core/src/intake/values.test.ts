import { describe, expect, it } from "vitest";
import {
  defaultDateOrder,
  defaultDecimalMark,
  detectDateOrder,
  detectDecimalMark,
  fold,
  isScientific,
  parseBoolean,
  parseDate,
  parseMoney,
  parseNumber,
  readEmail,
  readInstagram,
  readUrl,
  splitPhones,
  startOfDayUtc,
} from "./values";

const ctx = { today: "2026-09-27", timezone: "Asia/Dubai" };
const val = <T>(r: { ok: boolean; value?: T }) => (r.ok ? r.value : undefined);
const code = (r: { ok: boolean; issue?: { code: string } }) => (r.ok ? undefined : r.issue!.code);

describe("dates: the order of day and month, per column", () => {
  it.each([
    [["13/03/2026", "04/03/2026"], "DMY"],
    [["03/13/2026", "03/04/2026"], "MDY"],
    [["2026-03-04", "2026/03/05"], "YMD"],
    [["03/04/2026", "05/06/2026"], "ambiguous"],
    [["13/03/2026", "03/13/2026"], "conflict"],
    [["4 Mar 2026", "", "45123"], "ambiguous"],
  ])("%j → %s", (values, order) => expect(detectDateOrder(values)).toBe(order));

  it("defaults from the business country", () => {
    expect(defaultDateOrder("US")).toBe("MDY");
    expect(defaultDateOrder("AE")).toBe("DMY");
    expect(defaultDateOrder(null)).toBe("DMY");
  });
});

describe("parseDate", () => {
  it.each([
    ["04/03/2026", "DMY", "2026-03-04"],
    ["03/04/2026", "MDY", "2026-03-04"],
    ["04.03.26", "DMY", "2026-03-04"],
    ["4-3-2026", "DMY", "2026-03-04"],
    ["2026-03-04", "DMY", "2026-03-04"],
    ["4 Mar 2026", "MDY", "2026-03-04"],
    ["March 4, 2026", "DMY", "2026-03-04"],
    ["45720", "DMY", "2025-03-04"],
    ["04/03/99", "DMY", "1999-03-04"],
  ] as const)("%s (%s) → %s", (raw, order, date) => {
    expect(val(parseDate(raw, order, ctx))?.date).toBe(date);
  });

  it("reads a time in the business timezone, and converts an explicit offset", () => {
    expect(val(parseDate("2026-03-04 10:30", "YMD", ctx))?.instant).toBe("2026-03-04T06:30:00.000Z");
    expect(val(parseDate("2026-03-04T23:30:00Z", "YMD", ctx))).toEqual({
      date: "2026-03-05", // 03:30 on the 5th in Dubai
      instant: "2026-03-04T23:30:00.000Z",
    });
  });

  it.each([
    ["31/02/2026", "DATE_IMPOSSIBLE"],
    ["13/13/2026", "DATE_IMPOSSIBLE"],
    ["28/09/2026", "DATE_FUTURE"],
    ["01/01/1980", "DATE_TOO_OLD"],
    ["next tuesday", "DATE_UNREADABLE"],
  ])("refuses %s (%s)", (raw, c) => expect(code(parseDate(raw, "DMY", ctx))).toBe(c));
});

describe("numbers and money", () => {
  it("decides the decimal mark per column", () => {
    expect(detectDecimalMark(["1.234,50", "99,00"], ".")).toBe(",");
    expect(detectDecimalMark(["1,234.50", "99.00"], ",")).toBe(".");
    expect(detectDecimalMark(["1,234,567"], ",")).toBe(".");
    expect(detectDecimalMark(["4,5"], ".")).toBe(",");
    expect(detectDecimalMark(["1,234", "5,678"], ".")).toBe("."); // only ambiguous values: the business default
    expect(defaultDecimalMark("DE")).toBe(",");
    expect(defaultDecimalMark("AE")).toBe(".");
  });

  it.each([
    ["1,234.5", ".", 1234.5],
    ["1.234,5", ",", 1234.5],
    ["1 234,5", ",", 1234.5],
    ["1 234,5", ",", 1234.5], // a no-break space, as French Excel writes it
    ["1'234.50", ".", 1234.5],
    ["4500", ".", 4500],
    ["12%", ".", 12],
    ["-3", ".", -3],
  ] as const)("number %s (%s) → %d", (raw, mark, n) => expect(val(parseNumber(raw, mark))).toBe(n));

  it("refuses a number that isn't one", () => {
    expect(code(parseNumber("12 apples", "."))).toBe("NOT_A_NUMBER");
    expect(code(parseNumber("1,23,4", "."))).toBe("NOT_A_NUMBER");
  });

  it("reads money in the business currency, before or after, code or symbol", () => {
    expect(val(parseMoney("AED 4,500", ".", "AED"))).toBe(4500);
    expect(val(parseMoney("4,500 AED", ".", "AED"))).toBe(4500);
    expect(val(parseMoney("د.إ 4,500", ".", "AED"))).toBe(4500);
    expect(val(parseMoney("₹1,20,000", ".", "INR"))).toBe(120000); // Indian grouping
  });

  it("refuses another currency, negatives, and rounds past two decimals with a warning", () => {
    const usd = parseMoney("$1,200", ".", "AED");
    expect(code(usd)).toBe("FOREIGN_CURRENCY");
    expect(!usd.ok && usd.issue.message).toBe(
      "This amount is in USD; LUME works in AED — convert it before importing.",
    );
    expect(code(parseMoney("-50", ".", "AED"))).toBe("NEGATIVE_AMOUNT");
    const r = parseMoney("10.005", ".", "AED");
    expect(val(r)).toBe(10.01);
    expect(r.ok && r.warning?.code).toBe("AMOUNT_ROUNDED");
    // Half a cent rounds up from the digits typed, even where the float sits just below it.
    expect(val(parseMoney("5,000,000.015", ".", "AED"))).toBe(5000000.02);
  });
});

describe("booleans, contacts and links", () => {
  it.each([
    ["Yes", true],
    ["y", true],
    ["TRUE", true],
    ["1", true],
    ["✓", true],
    ["x", true],
    ["No", false],
    ["n", false],
    ["false", false],
    ["0", false],
    ["✗", false],
    ["maybe", null],
  ] as const)("%s → %s", (raw, b) => expect(parseBoolean(raw)).toBe(b));

  it("reads emails", () => {
    expect(readEmail(" Aisha@Example.COM ")).toBe("aisha@example.com");
    expect(readEmail("mailto:a@b.co")).toBe("a@b.co");
    expect(readEmail("not an email")).toBeNull();
  });

  it("reads Instagram handles from @names and profile links", () => {
    expect(readInstagram("@Aisha.K")).toBe("aisha.k");
    expect(readInstagram("https://www.instagram.com/aisha_k/?hl=en")).toBe("aisha_k");
    expect(readInstagram("instagram.com/aisha_k")).toBe("aisha_k");
    expect(readInstagram("not a handle!")).toBeNull();
    expect(readInstagram("a".repeat(31))).toBeNull();
  });

  it("reads links, adding https when missing", () => {
    expect(readUrl("brightpath.test/coaching")).toBe("https://brightpath.test/coaching");
    expect(readUrl("http://x.test/a")).toBe("http://x.test/a");
    expect(readUrl("not a link")).toBeNull();
  });

  it("splits several numbers in one cell, and spots Excel's scientific notation", () => {
    expect(splitPhones("050 111 2222 / 055 333 4444")).toEqual(["050 111 2222", "055 333 4444"]);
    expect(splitPhones("0501112222 or 0553334444")).toEqual(["0501112222", "0553334444"]);
    expect(splitPhones("+971 50 111 2222")).toEqual(["+971 50 111 2222"]);
    expect(isScientific("9.71501E+11")).toBe(true);
    expect(isScientific("9,71501E+11")).toBe(true);
    expect(isScientific("971501234567")).toBe(false);
  });

  it("finds midnight of a business-day as an instant", () => {
    expect(startOfDayUtc("2026-03-04", "Asia/Dubai").toISOString()).toBe("2026-03-03T20:00:00.000Z");
  });

  it("folds labels for matching", () => {
    expect(fold("  Café   Crème ")).toBe("cafe creme");
  });
});

describe("Review Focus 1: a semicolon CSV with comma decimals", () => {
  it("reads 1.234,50 as one thousand two hundred and thirty-four and a half", () => {
    const mark = detectDecimalMark(["1.234,50", "99,00", "12"], ".");
    expect(val(parseMoney("1.234,50", mark, "AED"))).toBe(1234.5);
    expect(
      val(parseDate("04.03.2026", detectDateOrder(["04.03.2026", "25.03.2026"]) as "DMY", ctx))?.date,
    ).toBe("2026-03-04");
  });
});
