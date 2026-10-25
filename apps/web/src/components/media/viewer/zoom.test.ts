import { describe, expect, it } from "vitest";
import { isClick, isMouseWheel, project, rubberband, softClamp } from "./zoom";

/** Zoom like Photos (owner, 2026-10-25): what the viewer's gestures are made of. */
describe("a mouse's wheel or a trackpad", () => {
  it("a wheel's notches (whole lines, or 120 a notch) zoom; a trackpad's small, sideways-capable steps pan", () => {
    expect(isMouseWheel({ deltaMode: 1, deltaX: 0, deltaY: 3 })).toBe(true);
    expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY: 100, wheelDeltaY: -120 })).toBe(true);
    expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY: 133.33, wheelDeltaY: -240 })).toBe(true);
    expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY: 4, wheelDeltaY: -12 })).toBe(false);
    expect(isMouseWheel({ deltaMode: 0, deltaX: 3, deltaY: 0, wheelDeltaY: 0 })).toBe(false);
    // A browser that says neither: a small step is a trackpad's.
    expect(isMouseWheel({ deltaMode: 0, deltaX: 0, deltaY: 2.5 })).toBe(false);
  });
});

describe("a click, not a drag", () => {
  it("under 6 px and quick", () => {
    expect(isClick({ x: 10, y: 10, t: 0 }, { x: 13, y: 12, t: 120 })).toBe(true);
    expect(isClick({ x: 10, y: 10, t: 0 }, { x: 18, y: 10, t: 120 })).toBe(false);
    expect(isClick({ x: 10, y: 10, t: 0 }, { x: 10, y: 10, t: 900 })).toBe(false);
  });
});

describe("soft edges", () => {
  it("past a limit the photo follows less and less, never stopping dead", () => {
    expect(softClamp(3, 1, 6, 1)).toBe(3);
    const a = softClamp(7, 1, 6, 1);
    const b = softClamp(9, 1, 6, 1);
    expect(a).toBeGreaterThan(6);
    expect(b).toBeGreaterThan(a);
    expect(b - 6).toBeLessThan(9 - 6);
    expect(softClamp(0.5, 1, 6, 1)).toBeLessThan(1);
    expect(softClamp(0.5, 1, 6, 1)).toBeGreaterThan(0.5);
    expect(rubberband(0, 100)).toBe(0);
    expect(rubberband(-50, 100)).toBeCloseTo(-rubberband(50, 100));
  });
});

describe("momentum", () => {
  it("Apple's projection: where a flick would come to rest", () => {
    expect(project(1000)).toBeCloseTo(499, 0);
    expect(project(0)).toBe(0);
    expect(project(-1000)).toBeCloseTo(-499, 0);
  });
});
