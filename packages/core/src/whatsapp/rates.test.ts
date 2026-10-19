import { describe, expect, it } from "vitest";
import { costOf } from "./rates";

describe("what WhatsApp charges for a template (W3b-2 Task 1)", () => {
  it("India's marketing rate, with the day the rate card was read", () => {
    expect(costOf("IN", "MARKETING")).toEqual({ amount: 0.86, currency: "INR", asOf: "2026-10-18" });
  });
  it("a market or category LUME has no rate for says nothing, rather than guess", () => {
    expect(costOf("ZZ", "MARKETING")).toBeNull();
    expect(costOf(null, "MARKETING")).toBeNull();
  });
});
