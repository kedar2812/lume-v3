import { describe, expect, it } from "vitest";
import { convertAmount, formatMoney, monthlyInr, rateOf, toInr } from "./money";

const RATES = { USD: 88.4, AED: 24.07, GBP: 118.6, EUR: 103.2, SGD: 68.9, AUD: 58.2 };

describe("money (spec §4.6)", () => {
  it("a rupee is a rupee; other currencies need today's rate, and a missing one is said, not invented", () => {
    expect(rateOf(RATES, "INR")).toBe(1);
    expect(rateOf(RATES, "AED")).toBe(24.07);
    expect(rateOf(RATES, "JPY")).toBeNull();
    expect(toInr(450, "AED", RATES)).toBeCloseTo(10831.5, 5);
    expect(toInr(450, "JPY", RATES)).toBeNull();
  });

  it("a yearly price counts a twelfth a month, a quarterly one a third; one-time is not monthly revenue", () => {
    expect(monthlyInr({ amount: 59988, currency: "INR", periodMonths: 12 }, RATES)).toBe(4999);
    expect(monthlyInr({ amount: 8997, currency: "INR", periodMonths: 3 }, RATES)).toBe(2999);
    expect(monthlyInr({ amount: 948, currency: "USD", periodMonths: 12 }, RATES)).toBeCloseTo(6983.6, 5);
    expect(monthlyInr({ amount: 1200, currency: "GBP", periodMonths: 0 }, RATES)).toBe(0);
    expect(monthlyInr({ amount: 120, currency: "JPY", periodMonths: 1 }, RATES)).toBeNull();
  });

  it("switching currency converts the typed price at today's rate, to a whole unit", () => {
    expect(convertAmount(3999, "INR", "AED", RATES)).toBe(166);
    expect(convertAmount(450, "AED", "INR", RATES)).toBe(10832);
    expect(convertAmount(450, "AED", "AED", RATES)).toBe(450);
    expect(convertAmount(0, "INR", "USD", RATES)).toBe(0);
    expect(convertAmount(450, "AED", "JPY", RATES)).toBeNull();
  });

  it("formats money in its own currency: lakh grouping for rupees", () => {
    expect(formatMoney(259988, "INR")).toBe("₹2,59,988");
    expect(formatMoney(450, "AED")).toBe("AED 450");
    expect(formatMoney(948, "USD")).toBe("$948");
    expect(formatMoney(1200, "GBP")).toBe("£1,200");
    expect(formatMoney(59.5, "EUR")).toBe("€59.50");
    expect(formatMoney(120, "CHF")).toBe("CHF 120");
  });
});
