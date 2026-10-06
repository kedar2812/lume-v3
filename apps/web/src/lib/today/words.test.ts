import { describe, expect, it } from "vitest";
import { sameDaysLastMonth } from "./words";

describe("what a month-to-date number is set against", () => {
  it("names the same days of last month", () => {
    expect(sameDaysLastMonth("2026-10-05")).toBe("vs Sep 1–5");
    expect(sameDaysLastMonth("2026-10-01")).toBe("vs Sep 1");
    // March 31 against a February that ends on the 28th; January against December.
    expect(sameDaysLastMonth("2026-03-31")).toBe("vs Feb 1–28");
    expect(sameDaysLastMonth("2026-01-15")).toBe("vs Dec 1–15");
  });
});
