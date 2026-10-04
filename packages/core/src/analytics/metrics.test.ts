import { describe, expect, it } from "vitest";
import { METRICS, METRIC_IDS } from "./metrics";

describe("the metric catalogue (8A)", () => {
  it("every metric has words, a basis said in its tooltip, and its own id", () => {
    for (const id of METRIC_IDS) {
      const m = METRICS[id];
      expect(m.id).toBe(id);
      expect(m.words.length).toBeGreaterThan(2);
      expect(m.info).toMatch(/Follows the leads that arrived|Counts what happened|As it stands right now/);
    }
  });

  it("every number opens its leads, except the one that's a rate of money over time", () => {
    expect(METRIC_IDS.filter((id) => !METRICS[id].drill)).toEqual(["velocity"]);
  });

  it("money is marked as money, so it's absent without analytics.revenue", () => {
    expect(METRIC_IDS.filter((id) => METRICS[id].revenue).sort()).toEqual(
      ["avg_deal", "forecast", "revenue_won", "velocity"].sort(),
    );
    for (const id of METRIC_IDS) if (METRICS[id].unit === "money") expect(METRICS[id].revenue).toBe(true);
  });

  it("estimates say so", () => {
    expect(METRICS.forecast.info).toContain("An estimate");
    expect(METRICS.velocity.info).toContain("An estimate");
  });

  it("rates move in points, counts in percent, and fewer is better where it should be", () => {
    for (const id of METRIC_IDS) if (METRICS[id].unit === "pct") expect(METRICS[id].trendKind).toBe("pts");
    for (const id of ["speed_to_lead", "no_show_rate", "overdue_now", "lateness", "cycle", "lost"] as const)
      expect(METRICS[id].good).toBe("down");
  });
});
