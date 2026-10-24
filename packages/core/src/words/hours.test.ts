import { describe, expect, it } from "vitest";
import { hoursLine } from "./hours";

/** The business's working hours in one line (Autopilot A3, the start sheet's "When", spec 2026-10-19 §1.2). */
describe("hoursLine", () => {
  it("a run of days, and times on the hour", () => {
    expect(hoursLine({ days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" })).toBe(
      "Monday to Saturday, 10 am to 7 pm",
    );
  });

  it("minutes, noon and midnight", () => {
    expect(hoursLine({ days: [1, 2, 3, 4, 5], start: "09:30", end: "12:00" })).toBe(
      "Monday to Friday, 9:30 am to 12 pm",
    );
    expect(hoursLine({ days: [6], start: "00:00", end: "12:30" })).toBe("Saturday, 12 am to 12:30 pm");
  });

  it("every day, and Sunday counted after Saturday", () => {
    expect(hoursLine({ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00" })).toBe(
      "Every day, 8 am to 8 pm",
    );
    expect(hoursLine({ days: [6, 0], start: "10:00", end: "14:00" })).toBe(
      "Saturday and Sunday, 10 am to 2 pm",
    );
    expect(hoursLine({ days: [5, 6, 0], start: "10:00", end: "14:00" })).toBe(
      "Friday to Sunday, 10 am to 2 pm",
    );
  });

  it("days that aren't a run are listed", () => {
    expect(hoursLine({ days: [1, 3, 5], start: "10:00", end: "17:00" })).toBe(
      "Monday, Wednesday and Friday, 10 am to 5 pm",
    );
  });

  it("no working days says so", () => {
    expect(hoursLine({ days: [], start: "10:00", end: "17:00" })).toBe("No working days set");
  });
});
