import { describe, expect, it } from "vitest";
import { day, dayShort, when } from "./format";
import { shortDay } from "./alerts";

/** Dates month first, as LUME writes them everywhere (owner's ruling 2026-10-18). */
describe("dates on the licence dashboard", () => {
  it("a day: month, day, then the year when it's given", () => {
    expect(day("2027-03-12")).toBe("Mar 12, 2027");
    expect(dayShort("2026-10-14")).toBe("Oct 14");
    expect(shortDay("2026-09-26")).toBe("Sep 26");
  });

  it("an instant, on the reader's own clock", () => {
    const at = new Date(2026, 8, 28, 9, 12).toISOString();
    expect(when(at)).toBe("Sep 28, 09:12");
  });
});
