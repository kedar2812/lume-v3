import { describe, expect, it } from "vitest";
import { apiRange, daysOf, monthGrid, rangeWords } from "./range";

const TODAY = "2026-10-05";

describe("the range picker's days and words", () => {
  it("each choice covers the days the canvas says, today included", () => {
    expect(daysOf("today", TODAY)).toEqual([TODAY, TODAY]);
    expect(daysOf("7d", TODAY)).toEqual(["2026-09-29", TODAY]);
    expect(daysOf("30d", TODAY)).toEqual(["2026-09-06", TODAY]);
    expect(daysOf("this_month", TODAY)).toEqual(["2026-10-01", TODAY]);
    expect(daysOf("last_month", TODAY)).toEqual(["2026-09-01", "2026-09-30"]);
    expect(daysOf("last_month", "2026-01-15")).toEqual(["2025-12-01", "2025-12-31"]);
    expect(daysOf("this_quarter", TODAY)).toEqual(["2026-10-01", TODAY]);
    expect(daysOf("12m", TODAY)).toEqual(["2025-10-06", TODAY]);
  });

  it("says what it covers and what it compares with", () => {
    expect(rangeWords("30d", TODAY)).toEqual({ label: "Last 30 days", vs: "vs the 30 before" });
    expect(rangeWords("this_month", TODAY)).toEqual({ label: "October 1 – 5", vs: "vs September 1 – 5" });
    expect(rangeWords("last_month", TODAY)).toEqual({ label: "September", vs: "vs August" });
    expect(rangeWords("this_quarter", "2026-11-03")).toEqual({
      label: "October 1 – November 3",
      vs: "vs the quarter before",
    });
    expect(rangeWords("custom", TODAY, { from: "2026-06-01", to: "2026-06-30" })).toEqual({
      label: "June 1 – 30",
      vs: "vs the 30 days before",
    });
  });

  it("the last 12 months asks the API for those days; the rest use its presets", () => {
    expect(apiRange("12m", TODAY)).toEqual({ range: "custom", from: "2025-10-06", to: TODAY });
    expect(apiRange("30d", TODAY)).toEqual({ range: "30d" });
  });

  it("a month is six weeks, Monday first: October 2026 starts on a Thursday", () => {
    const g = monthGrid("2026-10-01");
    expect(g).toHaveLength(42);
    expect(g[0]).toEqual({ day: "2026-09-28", inMonth: false });
    expect(g[3]).toEqual({ day: "2026-10-01", inMonth: true });
  });
});
