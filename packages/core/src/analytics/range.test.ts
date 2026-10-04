import { describe, expect, it } from "vitest";
import { dayOf, resolveRange } from "./range";

const IST = "Asia/Kolkata";
const NY = "America/New_York";

describe("analytics ranges, in the business's own days (8A)", () => {
  it("a moment belongs to the business day it falls on there, not the server's", () => {
    expect(dayOf(new Date("2026-10-04T18:00:00Z"), IST)).toBe("2026-10-04"); // 23:30 IST
    expect(dayOf(new Date("2026-10-04T18:30:00Z"), IST)).toBe("2026-10-05"); // 00:00 IST
  });

  it("today runs midnight to midnight there; the compare period is the day before", () => {
    const r = resolveRange("today", IST, new Date("2026-10-04T20:00:00Z")); // Oct 5, 01:30 IST
    expect(r.days).toEqual(["2026-10-05"]);
    expect(r.from.toISOString()).toBe("2026-10-04T18:30:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-05T18:30:00.000Z");
    expect(r.previous.days).toEqual(["2026-10-04"]);
    expect(r.label).toBe("October 5");
  });

  it("this month so far compares with the same days of last month, not all of it", () => {
    const r = resolveRange("this_month", IST, new Date("2026-10-03T08:00:00Z"));
    expect(r.days).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(r.previous.days).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(r.label).toBe("October 1 – 3");
    // March 31 has no February twin: the previous period stops at February's end.
    const m = resolveRange("this_month", IST, new Date("2026-03-31T08:00:00Z"));
    expect(m.previous.days.at(-1)).toBe("2026-02-28");
  });

  it("the last 7 and 30 days end today; last month is the whole of it", () => {
    const now = new Date("2026-10-15T06:00:00Z");
    expect(resolveRange("7d", IST, now).days).toHaveLength(7);
    expect(resolveRange("7d", IST, now).days.at(-1)).toBe("2026-10-15");
    expect(resolveRange("30d", IST, now).previous.days).toHaveLength(30);
    const lm = resolveRange("last_month", IST, now);
    expect(lm.days[0]).toBe("2026-09-01");
    expect(lm.days).toHaveLength(30);
    expect(lm.previous.days[0]).toBe("2026-08-01");
    expect(lm.label).toBe("September 1 – 30");
  });

  it("a day with the clock change is 25 hours long, and counted once", () => {
    const r = resolveRange("custom", NY, new Date("2026-11-10T12:00:00Z"), {
      from: "2026-11-01",
      to: "2026-11-01",
    });
    expect(r.to.getTime() - r.from.getTime()).toBe(25 * 3_600_000);
    expect(r.days).toEqual(["2026-11-01"]);
  });

  it("refuses a range that ends before it starts, or runs past a year", () => {
    expect(() => resolveRange("custom", IST, new Date(), { from: "2026-10-05", to: "2026-10-01" })).toThrow(
      /ends before/,
    );
    expect(() => resolveRange("custom", IST, new Date(), { from: "2024-01-01", to: "2026-01-01" })).toThrow(
      /a year/,
    );
  });
});
