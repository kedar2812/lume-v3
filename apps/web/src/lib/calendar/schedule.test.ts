import { describe, expect, it } from "vitest";
import { defaultStart, startOf } from "./schedule";

describe("a meeting's day and time, on the business's clock", () => {
  it("offers the next whole hour today, or 10 am tomorrow late in the day", () => {
    // 3:40 pm in Kolkata.
    expect(defaultStart(new Date("2026-11-13T10:10:00Z"), "Asia/Kolkata")).toEqual({
      date: "2026-11-13",
      time: "16:00",
    });
    // 8:10 pm in Kolkata: tomorrow morning.
    expect(defaultStart(new Date("2026-11-13T14:40:00Z"), "Asia/Kolkata")).toEqual({
      date: "2026-11-14",
      time: "10:00",
    });
  });

  it("reads the picked day and time on that clock, and refuses one that isn't real", () => {
    expect(startOf("2026-11-20", "17:00", "Asia/Kolkata")).toBe("2026-11-20T11:30:00.000Z");
    expect(startOf("2026-11-20", "17:00", "America/New_York")).toBe("2026-11-20T22:00:00.000Z");
    expect(startOf("2026-02-30", "10:00", "Asia/Kolkata")).toBeNull();
    expect(startOf("", "10:00", "Asia/Kolkata")).toBeNull();
  });
});
