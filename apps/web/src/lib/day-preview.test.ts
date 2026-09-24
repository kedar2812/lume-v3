import { describe, expect, it } from "vitest";
import { dayPreview, formatClock } from "./day-preview";

describe("dayPreview", () => {
  it("says the working week the way a person would", () => {
    expect(dayPreview([1, 2, 3, 4, 5], "09:00", "18:00", "08:00")).toBe(
      "Your digest arrives at 8:00 am, Monday to Friday. Reminders stay between 9:00 am and 6:00 pm.",
    );
    expect(dayPreview([6, 1, 3], "10:30", "14:00", "07:45")).toBe(
      "Your digest arrives at 7:45 am, Mon, Wed, Sat. Reminders stay between 10:30 am and 2:00 pm.",
    );
    expect(dayPreview([0, 1, 2, 3, 4, 5, 6], "09:00", "18:00", "08:00")).toMatch(/every day\./);
    expect(dayPreview([], "09:00", "18:00", "08:00")).toMatch(/no days yet/);
  });

  it("formats 24-hour times as a person reads them", () => {
    expect(formatClock("00:05")).toBe("12:05 am");
    expect(formatClock("12:00")).toBe("12:00 pm");
    expect(formatClock("23:59")).toBe("11:59 pm");
  });
});
