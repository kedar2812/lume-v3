import { describe, expect, it } from "vitest";
import { MARKET_OF, RATE_CARDS } from "./rate-card";
import { costOf, marketOf } from "./rates";

describe("what WhatsApp charges for a template: Meta's rate cards of October 1, 2026 (owner 2026-11-18)", () => {
  it("by the lead's country and the template's category, in the business's currency when Meta bills in it", () => {
    expect(costOf("IN", "MARKETING", "INR")).toEqual({ amount: 0.8631, currency: "INR", asOf: "2026-10-01" });
    expect(costOf("IN", "UTILITY", "INR")).toEqual({ amount: 0.115, currency: "INR", asOf: "2026-10-01" });
    expect(costOf("AE", "MARKETING", "AED")).toEqual({ amount: 0.2115, currency: "AED", asOf: "2026-10-01" });
    expect(costOf("IN", "MARKETING", "AED")).toEqual({ amount: 0.0433, currency: "AED", asOf: "2026-10-01" });
    expect(costOf("in", "MARKETING", "USD")).toEqual({ amount: 0.0118, currency: "USD", asOf: "2026-10-01" });
  });

  it("a currency Meta doesn't bill in gets the US dollar card (LUME converts it); none named is dollars", () => {
    expect(costOf("US", "MARKETING", "CAD")).toEqual({ amount: 0.025, currency: "USD", asOf: "2026-10-01" });
    expect(costOf("GB", "UTILITY")).toEqual({ amount: 0.022, currency: "USD", asOf: "2026-10-01" });
  });

  it("a country in a region pays the region's rate; one Meta doesn't list is Other", () => {
    expect(marketOf("ZW")).toBe("Rest of Africa");
    expect(marketOf("CA")).toBe("North America");
    expect(marketOf("JO")).toBe("Rest of Middle East");
    expect(marketOf("AQ")).toBe("Other");
    expect(costOf("ZW", "MARKETING", "USD")!.amount).toBe(0.0225);
    expect(costOf("AQ", "MARKETING", "USD")!.amount).toBe(0.0604);
  });

  it("no country (a number LUME can't place) says nothing, rather than guess", () => {
    expect(costOf(null, "MARKETING", "INR")).toBeNull();
    expect(costOf("", "MARKETING", "INR")).toBeNull();
  });

  it("the cards are whole: 16 currencies, each with every market Meta prices, and every country maps to one", () => {
    expect(Object.keys(RATE_CARDS)).toHaveLength(16);
    const markets = Object.keys(RATE_CARDS.USD!);
    expect(markets).toHaveLength(47);
    for (const [currency, card] of Object.entries(RATE_CARDS))
      expect([currency, Object.keys(card)]).toEqual([currency, markets]);
    for (const m of new Set(Object.values(MARKET_OF))) expect(markets).toContain(m);
    expect(Object.keys(MARKET_OF)).toHaveLength(141);
  });
});
