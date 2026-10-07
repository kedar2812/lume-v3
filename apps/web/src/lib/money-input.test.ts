import { describe, expect, it } from "vitest";
import { parseAmount } from "./money-input";

describe("an amount as a person types it", () => {
  it("grouping, spaces and a currency sign are fine", () => {
    expect(parseAmount("1,50,000")).toEqual({ value: 150000 });
    expect(parseAmount("₹ 25,000")).toEqual({ value: 25000 });
    expect(parseAmount("INR 4750.50")).toEqual({ value: 4750.5 });
    expect(parseAmount("$99")).toEqual({ value: 99 });
    expect(parseAmount("")).toEqual({ value: null });
  });
  it("not hex, not scientific, not negative, at most two decimals", () => {
    expect(parseAmount("0x1F")).toHaveProperty("error");
    expect(parseAmount("1e5")).toHaveProperty("error");
    expect(parseAmount("-500")).toEqual({ error: "Enter an amount of 0 or more" });
    expect(parseAmount("4750.555")).toEqual({ error: "Use at most two decimals" });
    expect(parseAmount("abc")).toEqual({ error: "Enter an amount, like 25,000" });
  });
});
