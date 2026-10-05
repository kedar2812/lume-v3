import { describe, expect, it } from "vitest";
import { areaUnder, band, niceMax, niceTicks, smooth, sparkLine, toPts } from "./chart";

describe("chart geometry (8C)", () => {
  it("a round top for the axis", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(420)).toBe(500);
  });

  it("points span the box; the biggest value touches the top", () => {
    expect(toPts([0, 5, 10], 100, 50, 10)).toEqual([
      [0, 50],
      [50, 25],
      [100, 0],
    ]);
  });

  it("a smooth line starts and ends on its points and never overshoots a flat stretch", () => {
    const d = smooth(toPts([3, 3, 3], 100, 50, 6));
    expect(d.startsWith("M0,25")).toBe(true);
    expect(d.endsWith("100,25")).toBe(true);
    expect(d).not.toMatch(/,2[0-4]\.|,2[6-9]\./); // flat stays flat
  });

  it("areas and bands close", () => {
    const top = toPts([2, 4], 10, 10, 4);
    expect(areaUnder(top, 10).endsWith("Z")).toBe(true);
    expect(band(top, toPts([0, 0], 10, 10, 4)).endsWith("Z")).toBe(true);
    expect(smooth([])).toBe("");
  });
});

describe("niceTicks", () => {
  it("steps by 1, 2 or 5 times a power of ten, from 0 to a top at least the largest value", () => {
    expect(niceTicks(46)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(niceTicks(50)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(1240)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(0)).toEqual([0, 1]);
    for (const v of [3, 13, 38, 99, 101, 777, 12_345]) {
      const t = niceTicks(v);
      expect(t.at(-1)!).toBeGreaterThanOrEqual(v);
      expect(t.length).toBeLessThanOrEqual(6);
      const step = t[1]! - t[0]!;
      expect(step / 10 ** Math.floor(Math.log10(step))).toSatisfy((m: number) => [1, 2, 5].includes(m));
    }
  });
});

describe("sparkLine", () => {
  it("needs three real days; a gap takes its neighbours' value", () => {
    expect(sparkLine([null, 4, null])).toBeNull();
    expect(sparkLine([2, null, 4])).toBeNull();
    expect(sparkLine([2, null, 4, 5])).toEqual([2, 3, 4, 5]);
    expect(sparkLine([null, 2, 2, 2])).toEqual([2, 2, 2, 2]);
  });
  it("calms a long run of noisy days with a three-day mean, keeping the total shape", () => {
    const days = Array.from({ length: 30 }, (_, i) => (i % 2 ? 10 : 0));
    const line = sparkLine(days)!;
    expect(line).toHaveLength(30);
    expect(Math.max(...line.slice(1, -1)) - Math.min(...line.slice(1, -1))).toBeLessThan(4);
    expect(sparkLine([0, 10, 0, 10, 0])).toEqual([0, 10, 0, 10, 0]);
  });
});
