import { describe, expect, it } from "vitest";
import { monthGrid } from "./CalendarRail";

describe("the mini month's weeks", () => {
  it("shows only the weeks the month covers", () => {
    // October 2026 starts on a Thursday and ends on a Saturday: five Monday weeks, Sep 28 – Nov 1.
    const oct = monthGrid("2026-10-15", "monday");
    expect(oct).toHaveLength(35);
    expect([oct[0], oct.at(-1)]).toEqual(["2026-09-28", "2026-11-01"]);
    // August 2026 needs six Monday weeks (Jul 27 – Sep 6); February 2026 four (Feb 2 – Mar 1).
    expect(monthGrid("2026-08-01", "monday")).toHaveLength(42);
    expect(monthGrid("2026-02-10", "sunday").length).toBeGreaterThanOrEqual(28);
  });
});
