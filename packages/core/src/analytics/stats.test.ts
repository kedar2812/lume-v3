import { describe, expect, it } from "vitest";
import { normalCdf, twoProportion, wilson } from "./stats";

describe("the statistics behind suggestions (8B)", () => {
  it("the normal CDF matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.644854)).toBeCloseTo(0.05, 5);
  });

  it("a two-proportion test: a real gap is significant, a coin-flip gap isn't", () => {
    // 60/100 against 40/100: z = 2.828, p = 0.0047 (textbook).
    const t = twoProportion(60, 100, 40, 100);
    expect(t.z).toBeCloseTo(2.828, 3);
    expect(t.p).toBeCloseTo(0.0047, 4);
    // 6/10 against 4/10: the same rates, too few to say.
    expect(twoProportion(6, 10, 4, 10).p).toBeGreaterThan(0.3);
    expect(twoProportion(1, 0, 1, 10).p).toBe(1);
  });

  it("the Wilson interval stays inside 0–1 and narrows with more data", () => {
    const [lo, hi] = wilson(0, 10);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(0.2775, 3);
    const small = wilson(5, 10);
    const big = wilson(500, 1000);
    expect(big[1] - big[0]).toBeLessThan(small[1] - small[0]);
  });
});
