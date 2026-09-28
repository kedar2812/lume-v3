import { describe, expect, it } from "vitest";
import { localInputToIso, whenInWords } from "./format";

// 2026-09-28 is a Monday. 08:00Z is 12:00 in Dubai and 13:30 in Kolkata.
const now = new Date("2026-09-28T08:00:00Z");
const DUBAI = "Asia/Dubai";
const KOLKATA = "Asia/Kolkata";

describe("whenInWords", () => {
  it("soon, today, tomorrow, this week, and later — in the person's own day", () => {
    expect(whenInWords("2026-09-28T08:45:00Z", now, DUBAI)).toBe("In 45 min");
    expect(whenInWords("2026-09-28T12:30:00Z", now, DUBAI)).toBe("Today, 16:30");
    expect(whenInWords("2026-09-29T06:00:00Z", now, DUBAI)).toBe("Tomorrow, 10:00");
    expect(whenInWords("2026-10-01T06:00:00Z", now, DUBAI)).toBe("Thu, 10:00");
    expect(whenInWords("2026-10-05T06:00:00Z", now, DUBAI)).toBe("Mon 5 Oct, 10:00");
  });

  it("the same instant can be today in one place and tomorrow in another", () => {
    const late = "2026-09-28T19:00:00Z"; // 23:00 in Dubai, 00:30 on the 29th in Kolkata
    expect(whenInWords(late, now, DUBAI)).toBe("Today, 23:00");
    expect(whenInWords(late, now, KOLKATA)).toBe("Tomorrow, 00:30");
  });

  it("past its time, it says so", () => {
    expect(whenInWords("2026-09-28T07:40:00Z", now, DUBAI)).toBe("20 min overdue");
    expect(whenInWords("2026-09-28T05:00:00Z", now, DUBAI)).toBe("Today, 09:00 (overdue)");
    expect(whenInWords("2026-09-27T14:00:00Z", now, DUBAI)).toBe("Yesterday, 18:00 (overdue)");
  });
});

describe("localInputToIso", () => {
  it("reads a datetime-local value as the person's wall clock, not the browser's", () => {
    expect(localInputToIso("2026-09-29T10:00", DUBAI)).toBe("2026-09-29T06:00:00.000Z");
    expect(localInputToIso("2026-09-29T10:00", KOLKATA)).toBe("2026-09-29T04:30:00.000Z");
    expect(localInputToIso("not a time", DUBAI)).toBeNull();
  });
});
