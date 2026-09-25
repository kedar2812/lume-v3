import { describe, expect, it } from "vitest";
import { CURRENCIES, currencyCountry, isCurrency } from "./currencies";

describe("currencies", () => {
  it("lists the currencies in use today, once each, and not retired ones", () => {
    expect(CURRENCIES).toContain("AED");
    expect(CURRENCIES).toContain("INR");
    expect(CURRENCIES).toContain("EUR");
    expect(new Set(CURRENCIES).size).toBe(CURRENCIES.length);
    for (const retired of ["HRK", "SLL", "ANG", "VEF"]) expect(CURRENCIES).not.toContain(retired);
    expect(CURRENCIES.length).toBeGreaterThan(150);
  });

  it("knows a real code from three random letters", () => {
    expect(isCurrency("USD")).toBe(true);
    expect(isCurrency("ZZZ")).toBe(false);
    expect(isCurrency("usd")).toBe(false);
  });

  it("names the country whose flag stands for a currency, when one does", () => {
    expect(currencyCountry("AED")).toBe("AE");
    expect(currencyCountry("GBP")).toBe("GB");
    expect(currencyCountry("EUR")).toBe("EU");
    expect(currencyCountry("XOF")).toBeNull(); // shared by several countries: no single flag
  });
});
