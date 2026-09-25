import { describe, expect, it } from "vitest";
import { formatOffset, guessTimezone, localTime, searchTimezones, timezoneOptions } from "./timezones";

describe("timezones", () => {
  it("lists real zones with a readable label and their current offset", () => {
    const all = timezoneOptions();
    expect(all.length).toBeGreaterThan(100);
    const dubai = all.find((z) => z.id === "Asia/Dubai")!;
    expect(dubai.label).toBe("Dubai");
    expect(dubai.offset).toBe("UTC+4");
  });

  it("finds a zone by city, by id and by offset", () => {
    expect(searchTimezones("dubai").map((z) => z.id)).toContain("Asia/Dubai");
    expect(searchTimezones("asia/kol").map((z) => z.id)).toContain("Asia/Kolkata");
    expect(searchTimezones("+4").map((z) => z.id)).toContain("Asia/Dubai");
    expect(searchTimezones("zzzz")).toEqual([]);
  });

  it("guesses a zone that really exists, and formats UTC as UTC+0", () => {
    expect(timezoneOptions().some((z) => z.id === guessTimezone())).toBe(true);
    expect(formatOffset("UTC")).toBe("UTC+0");
  });

  it("shows each zone's own clock, so the choice can be checked at a glance", () => {
    const at = new Date("2026-09-24T06:30:00Z");
    expect(localTime("Asia/Dubai", at)).toBe("10:30 am");
    expect(localTime("Asia/Kolkata", at)).toBe("12:00 pm");
  });
});
