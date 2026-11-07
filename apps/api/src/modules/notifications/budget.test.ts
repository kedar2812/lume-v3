import { describe, expect, it } from "vitest";
import { leadsDelay, leadsEveryMs } from "./budget";

/**
 * "Leads changed" to every open stream (4B): each browser then reads its counts again. A thousand people on one LUME
 * (owner, 2026-11-06: "1000 people using it at the same time should raise no issues") must not all read at once.
 */
describe("the refresh budget", () => {
  it("a small team hears within 3 s, as before", () => {
    expect(leadsEveryMs(1)).toBe(3000);
    expect(leadsEveryMs(150)).toBe(3000);
  });

  it("a big one is told less often, so the whole team's re-reads stay near 60 a second", () => {
    expect(leadsEveryMs(1000)).toBe(16_667);
    expect(leadsEveryMs(3000)).toBe(50_000);
  });

  it("each stream takes its own moment inside the window, never all at once", () => {
    // A small team: next to no wait.
    expect(leadsDelay({ streams: 5, wait: 0, rand: () => 0.99 })).toBeLessThan(30);
    // A thousand: spread over up to 5 s, and never sooner than the window allows.
    const spread = [0, 0.5, 0.999].map((r) => leadsDelay({ streams: 1000, wait: 0, rand: () => r }));
    expect(spread[0]).toBe(0);
    expect(spread[2]).toBeGreaterThan(4900);
    expect(spread[2]).toBeLessThanOrEqual(5000);
    expect(leadsDelay({ streams: 1000, wait: 4000, rand: () => 0 })).toBe(4000);
  });
});
