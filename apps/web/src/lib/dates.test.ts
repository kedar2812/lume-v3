import { describe, expect, it } from "vitest";
import { dateTime, dayKey, longDate, nearDay, shortDate, timeOf, weekOf } from "./dates";

const DXB = "Asia/Dubai";

describe("dates, month first (owner, 2026-10-01)", () => {
  const thu = new Date("2026-10-01T10:30:00Z"); // 2:30 pm in Dubai

  it("reads a full date month first, then the day of the week", () => {
    expect(longDate(thu, DXB)).toBe("October 1, Thursday");
  });

  it("has a short form and one with a time", () => {
    expect(shortDate(thu, DXB)).toBe("Oct 1, Thu");
    expect(dateTime(thu, DXB)).toBe("Oct 1, Thu, 2:30 pm");
  });

  it("says times the way LUME's messages do: 12 pm and 12 am on the hour", () => {
    expect(timeOf(new Date("2026-10-01T08:00:00Z"), DXB)).toBe("12 pm");
    expect(timeOf(new Date("2026-09-30T20:00:00Z"), DXB)).toBe("12 am");
    expect(timeOf(new Date("2026-10-01T05:05:00Z"), DXB)).toBe("9:05 am");
  });

  it("calls near days by name, on the business's clock", () => {
    const now = new Date("2026-10-01T06:00:00Z");
    expect(nearDay(thu, DXB, now)).toBe("Today");
    expect(nearDay(new Date("2026-10-02T06:00:00Z"), DXB, now)).toBe("Tomorrow");
    expect(nearDay(new Date("2026-09-30T06:00:00Z"), DXB, now)).toBe("Yesterday");
    expect(nearDay(new Date("2026-10-05T06:00:00Z"), DXB, now)).toBe("October 5, Monday");
  });

  it("Review Focus 1: a meeting at 11:30 pm in Dubai is on the Dubai day, whatever the browser's zone", () => {
    const late = new Date("2026-10-01T19:30:00Z"); // 23:30 in Dubai, 15:30 in New York
    expect(dayKey(late, DXB)).toBe("2026-10-01");
    expect(dayKey(new Date("2026-10-01T20:30:00Z"), DXB)).toBe("2026-10-02");
  });

  it("lays out a week from its first day, across a month boundary", () => {
    expect(weekOf("2026-10-01", "monday")).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(weekOf("2026-10-01", "sunday")[0]).toBe("2026-09-27");
  });
});
