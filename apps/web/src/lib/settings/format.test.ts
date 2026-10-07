import { describe, expect, it } from "vitest";
import { settingsDate, settingsDateTime } from "./format";

/** Settings' dates: month first and "2:05 pm", as everywhere in LUME, on the person's clock — never the machine's. */
describe("dates in Settings", () => {
  const at = "2026-09-22T20:35:00Z"; // Sep 23, 2:05 am in Kolkata; Sep 22, 4:35 pm in New York
  it("month first, in the person's zone", () => {
    expect(settingsDate(at, "Asia/Kolkata")).toBe("Sep 23, 2026");
    expect(settingsDate(at, "America/New_York")).toBe("Sep 22, 2026");
    expect(settingsDate(at, "Asia/Kolkata", false)).toBe("Sep 23");
  });
  it("with the time in LUME's words", () => {
    expect(settingsDateTime(at, "Asia/Kolkata")).toBe("Sep 23, 2:05 am");
    expect(settingsDateTime(at, "America/New_York")).toBe("Sep 22, 4:35 pm");
  });
});
