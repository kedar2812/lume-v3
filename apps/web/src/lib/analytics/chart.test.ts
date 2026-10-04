import { describe, expect, it } from "vitest";
import { areaUnder, band, niceMax, smooth, toPts } from "./chart";

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
