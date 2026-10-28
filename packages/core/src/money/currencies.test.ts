import { describe, expect, it } from "vitest";
import { CURRENCIES, currencyCountry, currencyForCountry, isCurrency } from "./currencies";

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

  it("finds the currency a country uses, for a first guess in setup", () => {
    expect(currencyForCountry("IN")).toBe("INR");
    expect(currencyForCountry("AE")).toBe("AED");
    expect(currencyForCountry("us")).toBe("USD");
    expect(currencyForCountry("DE")).toBe("EUR");
    expect(currencyForCountry("ZZ")).toBeNull();
    // Bulgaria is in the euro since 2026; El Salvador, Ecuador and Timor-Leste use the US dollar; Montenegro and
    // Kosovo the euro without being members (review C12).
    expect(currencyForCountry("BG")).toBe("EUR");
    expect(currencyForCountry("SV")).toBe("USD");
    expect(currencyForCountry("EC")).toBe("USD");
    expect(currencyForCountry("TL")).toBe("USD");
    expect(currencyForCountry("ME")).toBe("EUR");
    expect(currencyForCountry("XK")).toBe("EUR");
  });
});
