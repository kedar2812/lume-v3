import { describe, expect, it } from "vitest";
import { hoursInWords } from "./hours";

describe("business hours in words (the house style: 10 am, 7:30 pm)", () => {
  it("says the days, then the hours as people say them", () => {
    expect(hoursInWords({ days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" })).toBe(
      "Monday to Saturday, 10 am – 7 pm",
    );
    expect(hoursInWords({ days: [0, 1, 2, 3, 4, 5, 6], start: "09:30", end: "18:00" })).toBe(
      "Every day, 9:30 am – 6 pm",
    );
    expect(hoursInWords({ days: [1, 3], start: "12:00", end: "23:59" })).toBe(
      "Monday and Wednesday, 12 pm – midnight",
    );
  });
});
