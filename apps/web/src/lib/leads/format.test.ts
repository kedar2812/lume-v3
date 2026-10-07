import { describe, expect, it } from "vitest";
import { fieldText, formatMoney, relativeTime } from "./format";
import { testCatalog } from "./test-catalog";

describe("formatting", () => {
  it("shows money the way the business counts it", () => {
    expect(formatMoney(4500, "AED")).toBe("AED 4,500");
    expect(formatMoney(4500.5, "AED")).toBe("AED 4,500.50");
    expect(formatMoney(0, "AED")).toBe("AED 0");
    expect(formatMoney(null, "AED")).toBe("");
    // Rupees grouped in lakhs, as Analytics and Goals already read them.
    expect(formatMoney(102300, "INR")).toBe("INR 1,02,300");
    expect(formatMoney(15000000.5, "INR")).toBe("INR 1,50,00,000.50");
  });

  it("says how long ago in words, falling back to a date after a week", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    expect(relativeTime("2026-09-25T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-09-25T11:40:00Z", now)).toBe("20m ago");
    expect(relativeTime("2026-09-25T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-23T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("2026-09-01T12:00:00Z", now)).toBe("Sep 1");
    expect(relativeTime("2025-09-01T12:00:00Z", now)).toBe("Sep 1, 2025");
    expect(relativeTime("2026-09-25T12:05:00Z", now)).toBe("just now"); // a clock slightly ahead
  });

  it("turns any field value into text, options by label and people by name", () => {
    const cat = testCatalog();
    const struggles = cat.fields.find((f) => f.key === "struggles")!;
    expect(fieldText(["o1", "o2"], struggles, cat)).toBe("Confidence, Career switch");
    const handled = cat.fields.find((f) => f.type === "user")!;
    expect(fieldText("u-riya", handled, cat)).toBe("Riya Sharma");
    expect(fieldText("u-gone", handled, cat)).toBe("Someone who left");
    expect(fieldText(true, { ...handled, type: "boolean" }, cat)).toBe("Yes");
    expect(fieldText("2026-09-01", { ...handled, type: "date" }, cat)).toBe("Sep 1, 2026");
    expect(fieldText(undefined, handled, cat)).toBe("");
  });
  it("dates are month first and on the person's clock; a date-time field reads in their zone", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    // 9 pm UTC on Sep 1 is already Sep 2 in Kolkata.
    expect(relativeTime("2026-09-01T21:00:00Z", now, "Asia/Kolkata")).toBe("Sep 2");
    expect(relativeTime("2026-09-01T21:00:00Z", now, "UTC")).toBe("Sep 1");
    const cat = testCatalog();
    const def = { ...cat.fields[0]!, type: "datetime" as const };
    expect(fieldText("2026-09-01T09:30:00Z", def, cat, "Asia/Kolkata")).toBe("Sep 1, 2026, 3 pm");
  });
});
