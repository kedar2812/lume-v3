import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetRatesForTests, rateFor, ratesSettledForTests } from "./fx-cache";
import type { RateSource } from "./rates";

const source = (rate: number | null) => {
  const quote = vi.fn(async () => {
    if (rate === null) throw new Error("down");
    return { rate, asOf: "2026-11-18T00:00:00Z", source: "test" };
  });
  return { quote } satisfies RateSource;
};

beforeEach(() => forgetRatesForTests());

describe("a rate for an estimate in the business currency (owner 2026-11-18)", () => {
  it("never waits on the internet: the first ask is answered null and fetched behind, once for everyone", async () => {
    const s = source(1.4);
    expect(rateFor(s, "USD", "CAD", 0)).toBeNull();
    expect(rateFor(s, "USD", "CAD", 0)).toBeNull(); // still on its way: not asked twice
    expect(s.quote).toHaveBeenCalledTimes(1);
    await ratesSettledForTests();
    expect(rateFor(s, "USD", "CAD", 1000)).toBe(1.4);
  });

  it("kept for half a day; an old one serves while the new one is fetched", async () => {
    const s = source(1.4);
    rateFor(s, "USD", "CAD", 0);
    await ratesSettledForTests();
    expect(rateFor(s, "USD", "CAD", 11 * 3_600_000)).toBe(1.4);
    expect(s.quote).toHaveBeenCalledTimes(1);
    expect(rateFor(s, "USD", "CAD", 13 * 3_600_000)).toBe(1.4);
    expect(s.quote).toHaveBeenCalledTimes(2);
  });

  it("none to be had: null (shown in the card's own currency), and not asked again for a while", async () => {
    const s = source(null);
    rateFor(s, "USD", "CAD", 0);
    await ratesSettledForTests();
    expect(rateFor(s, "USD", "CAD", 60_000)).toBeNull();
    expect(s.quote).toHaveBeenCalledTimes(1);
    expect(rateFor(undefined, "USD", "CAD", 0)).toBeNull();
  });

  it("the same currency needs no rate", () => {
    const s = source(2);
    expect(rateFor(s, "INR", "INR")).toBe(1);
    expect(s.quote).not.toHaveBeenCalled();
  });
});
