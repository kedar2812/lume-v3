import { describe, expect, it } from "vitest";
import {
  SPRINGS,
  project,
  rubberband,
  settleTime,
  springAt,
  springCssVars,
  toLinearEasing,
  toMotion,
} from "./motion";

describe("springs (Apple damping + response)", () => {
  it("start at 0 and settle at 1", () => {
    for (const s of Object.values(SPRINGS)) {
      expect(springAt(s, 0)).toBeCloseTo(0, 6);
      expect(springAt(s, settleTime(s))).toBeCloseTo(1, 2);
    }
  });

  it("critically damped springs never overshoot; bouncy ones do", () => {
    const peak = (s: (typeof SPRINGS)[keyof typeof SPRINGS]) =>
      Math.max(...Array.from({ length: 200 }, (_, i) => springAt(s, (settleTime(s) * i) / 199)));
    expect(peak(SPRINGS.default)).toBeLessThanOrEqual(1 + 1e-9);
    expect(peak(SPRINGS.soft)).toBeLessThanOrEqual(1 + 1e-9);
    expect(peak(SPRINGS.bounce)).toBeGreaterThan(1.01);
  });

  it("uses the spec's values", () => {
    expect(SPRINGS).toEqual({
      default: { bounce: 0, response: 0.38 },
      soft: { bounce: 0, response: 0.7 },
      bounce: { bounce: 0.3, response: 0.42 },
      drawer: { bounce: 0.2, response: 0.3 },
    });
  });

  it("emits a CSS linear() easing that starts at 0 and ends at 1", () => {
    const e = toLinearEasing(SPRINGS.default, 40);
    expect(e).toMatch(/^linear\(0(\.0+)?, /);
    expect(e.endsWith(", 1)")).toBe(true);
    expect(e.split(",").length).toBe(41);
  });

  it("maps to Motion's spring config", () => {
    expect(toMotion(SPRINGS.bounce)).toEqual({ type: "spring", bounce: 0.3, visualDuration: 0.42 });
  });

  it("exposes CSS variables for every spring", () => {
    expect(Object.keys(springCssVars()).sort()).toEqual([
      "--spring",
      "--spring-bounce",
      "--spring-drawer",
      "--spring-soft",
    ]);
  });
});

describe("gesture maths", () => {
  it("projects momentum like UIScrollView (d = 0.998)", () => {
    expect(project(1000)).toBeCloseTo(499, 0);
    expect(project(-500)).toBeCloseTo(-249.5, 1);
  });

  it("rubber-bands: 0 at the edge, monotonic, never reaching the dimension", () => {
    expect(rubberband(0, 300)).toBe(0);
    expect(rubberband(50, 300)).toBeLessThan(50);
    expect(rubberband(100, 300)).toBeGreaterThan(rubberband(50, 300));
    expect(rubberband(1e6, 300)).toBeLessThan(300);
    expect(rubberband(-50, 300)).toBeCloseTo(-rubberband(50, 300), 9);
  });
});
