import { describe, expect, it } from "vitest";
import { sinceWords } from "./since";

/** "12 new since this morning": the day and the morning are the person's, not the browser's. */
describe("since when, in the person's own day", () => {
  const now = new Date("2026-10-06T10:00:00Z"); // 3:30 pm in Kolkata; 6 am in New York
  it("this morning / earlier today by the person's clock", () => {
    expect(sinceWords("2026-10-06T03:00:00Z", "Asia/Kolkata", now)).toBe("this morning"); // 8:30 am IST
    expect(sinceWords("2026-10-06T08:00:00Z", "Asia/Kolkata", now)).toBe("earlier today"); // 1:30 pm IST
  });
  it("yesterday where the person is, even when it's today in UTC", () => {
    // 1 am UTC on the 6th is still the evening of the 5th in New York.
    expect(sinceWords("2026-10-06T01:00:00Z", "America/New_York", now)).toBe("yesterday");
    expect(sinceWords("2026-10-06T01:00:00Z", "Asia/Kolkata", now)).toBe("this morning");
  });
  it("a weekday within the week, then a short date", () => {
    expect(sinceWords("2026-10-02T09:00:00Z", "Asia/Kolkata", now)).toBe("Friday");
    expect(sinceWords("2026-09-20T09:00:00Z", "Asia/Kolkata", now)).toBe("Sep 20");
  });
});
