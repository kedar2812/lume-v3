import { describe, expect, it } from "vitest";
import { computeAnalytics, type AClient } from "./analytics";
import { CANVAS_CLIENTS, CANVAS_DECLINING, CANVAS_LIST_PRICE, CANVAS_NOW, CANVAS_RATES } from "./fixture";

const run = (clients: AClient[], range: 3 | 6 | 12 = 12, rates: Record<string, number> = CANVAS_RATES) =>
  computeAnalytics({ clients, rates, now: CANVAS_NOW, range, listPriceInr: CANVAS_LIST_PRICE });

describe("analytics, against the canvas's own numbers (spec §4.4)", () => {
  const a = run(CANVAS_CLIENTS);

  it("monthly revenue, the run rate and paying clients, now and last month", () => {
    expect(a.mrr).toBeCloseTo(65926.7, 1);
    expect(a.mrrBefore).toBeCloseTo(56257.9, 1);
    expect(a.arr).toBeCloseTo(65926.7 * 12, 1);
    expect(a.paying).toBe(12);
    expect(a.payingBefore).toBe(11);
    expect(a.joined).toBe(2);
    expect(a.left).toBe(1);
  });

  it("the revenue series, month by month, over the range", () => {
    expect(a.series.map((p) => Math.round(p.mrr * 10) / 10)).toEqual([
      0, 0, 0, 2499, 9482.6, 17907.1, 22906.1, 31404.1, 39672.1, 43171.1, 46170.1, 56257.9, 65926.7,
    ]);
    expect(a.series[0]!.month).toBe("2025-09");
    expect(a.series.at(-1)!.month).toBe("2026-09");
    expect(a.series.at(-1)).toMatchObject({ joined: 2, left: 1 });
    expect(run(CANVAS_CLIENTS, 3).series).toHaveLength(4);
  });

  it("average monthly growth, compounded from the first month with revenue", () => {
    expect(a.growth).toBeCloseTo(0.43853911667902334, 10);
    expect(run(CANVAS_DECLINING).growth).toBeCloseTo(0.3493819787520538, 10);
  });

  it("clients lost, average per client and lifetime value, now and a month before", () => {
    expect(a.churn).toBeCloseTo(1 / 51, 10);
    expect(a.churnBefore).toBe(0);
    expect(a.lost).toBe(1);
    expect(a.arpa).toBeCloseTo(5493.891666666666, 6);
    expect(a.arpaBefore).toBeCloseTo(5114.354545454546, 6);
    expect(a.ltv).toBeCloseTo(280188.475, 3);
    expect(a.ltvBefore).toBe(0);
  });

  it("what moved it: start, new, price up, price down, lost, now", () => {
    expect(a.moves.start).toBe(0);
    expect(a.moves.new).toBeCloseTo(66018.7, 1);
    expect(a.moves.up).toBeCloseTo(2407, 1);
    expect(a.moves.down).toBe(0);
    expect(a.moves.lost).toBeCloseTo(2499, 1);
    expect(a.moves.now).toBeCloseTo(65926.7, 1);
    const d = run(CANVAS_DECLINING);
    expect(d.mrr).toBeCloseTo(37066.4, 1);
    expect(d.moves.lost).toBeCloseTo(19191.5, 1);
    expect(d.churn).toBeCloseTo(3 / 51, 10);
  });

  it("countries and India by state: every current client, or those new in the range", () => {
    expect(a.countries.all[0]).toEqual({ country: "IN", clients: 8, mrrInr: expect.any(Number) });
    expect(a.countries.all.map((c) => c.country)).toEqual(["IN", "AE", "SG", "US", "DE", "AU", "GB"]);
    expect(a.states.all).toEqual([
      { region: "MH", clients: 3 },
      { region: "KA", clients: 2 },
      { region: "DL", clients: 1 },
      { region: "TN", clients: 1 },
      { region: "TS", clients: 1 },
    ]);
    // New in the last 3 months: Harbour, Cedar, Lotus, Riverstone, Fjord, Coral Bay.
    expect(run(CANVAS_CLIENTS, 3).countries.fresh.reduce((n, c) => n + c.clients, 0)).toBe(6);
  });

  it("revenue by currency, and from abroad", () => {
    expect(a.currencies.map((c) => c.currency)).toEqual(["INR", "AED", "SGD", "USD", "EUR", "AUD"]);
    expect(a.currencies.reduce((n, c) => n + c.mrrInr, 0)).toBeCloseTo(a.mrr, 6);
    expect(a.abroadInr).toBeCloseTo(6983.6 + 10831.5 + 8268 + 5761.8 + 6088.8, 1);
  });

  it("sources, and the price spread against the list price", () => {
    expect(a.sources[0]).toMatchObject({ source: "referrals", clients: 5, paying: 5 });
    expect(a.sources[0]!.mrrInr).toBeCloseTo(29327.5, 1);
    expect(a.spread).toHaveLength(12);
    expect(a.spread.map((p) => p.mrrInr)).toEqual([...a.spread.map((p) => p.mrrInr)].sort((x, y) => x - y));
    expect(a.belowList).toBe(3);
  });

  it("ideas to grow, from the numbers", () => {
    expect(a.ideas.map((i) => i.title)).toEqual([
      "Referrals bring 44% of your revenue",
      "Clients abroad pay 1.9× more a month",
      "3 clients pay below your list price",
      expect.stringMatching(/^₹1 lakh a month in about \d+ months$/),
    ]);
    expect(run(CANVAS_DECLINING).ideas[3]!.title).toMatch(/^Revenue is down 34% on Aug$/);
  });

  it("a currency with no rate is left out of the rupee totals and named, never guessed", () => {
    const { SGD: _gone, ...rates } = CANVAS_RATES;
    void _gone;
    const r = run(CANVAS_CLIENTS, 12, rates);
    expect(r.missingRates).toEqual(["SGD"]);
    expect(r.mrr).toBeCloseTo(65926.7 - 120 * 68.9, 1);
  });

  it("nothing yet: zeros and no ideas, not errors", () => {
    const e = run([]);
    expect(e).toMatchObject({ mrr: 0, paying: 0, growth: 0, churn: 0, ltv: 0, belowList: 0 });
    expect(e.ideas).toEqual([]);
  });

  it("trial to paid: bought over the trials that have finished, now and a month ago", () => {
    const t = (
      id: string,
      created: string,
      trialEnds: string,
      paying: string | null,
      type: AClient["type"],
    ) =>
      ({
        id,
        name: id,
        country: "IN",
        region: null,
        source: "demo",
        type,
        createdAt: new Date(created),
        payingSince: paying ? new Date(paying) : null,
        endedAt: null,
        trialEnds,
        trialStarted: true,
        prices: [{ currency: "INR", amount: 3999, periodMonths: 1, from: new Date(created) }],
      }) satisfies AClient;
    const r = run([
      t("a", "2026-06-01T00:00:00Z", "2026-06-15", "2026-06-14T00:00:00Z", "subscription"),
      t("b", "2026-07-01T00:00:00Z", "2026-07-15", null, "trial"),
      t("c", "2026-09-01T00:00:00Z", "2026-09-15", "2026-09-10T00:00:00Z", "subscription"),
      t("d", "2026-09-20T00:00:00Z", "2026-10-04", null, "trial"),
    ]);
    // Now: 3 finished (a, b, c), 2 bought. A month ago: 2 finished (a, b), 1 bought.
    expect(r.trials).toEqual({ started: 4, bought: 2, running: 1, rate: 2 / 3, rateBefore: 1 / 2 });
  });
});
