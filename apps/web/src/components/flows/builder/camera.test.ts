import { describe, expect, it } from "vitest";
import {
  clampZ,
  decay,
  fitCam,
  projection,
  releaseSpeed,
  soft,
  springStep,
  toCanvas,
  wheelKind,
  zoomAbout,
  Z_MAX,
  Z_MIN,
} from "./camera";

/** The builder's camera, as the approved canvas board moves (KJJDFJ7wddubXwRuked4m9, Builder). */
describe("the camera", () => {
  it("zooms about the cursor: the canvas point under it stays under it", () => {
    const cam = { x: 120, y: -40, z: 0.8 };
    const before = toCanvas(cam, 500, 300);
    const after = zoomAbout(cam, 1.6, 500, 300);
    expect(after.z).toBe(1.6);
    const still = toCanvas(after, 500, 300);
    expect(still.x).toBeCloseTo(before.x, 9);
    expect(still.y).toBeCloseTo(before.y, 9);
  });

  it("past the limits a pinch gives a quarter as much; the limits themselves hold", () => {
    expect(soft(1)).toBe(1);
    expect(soft(Z_MAX + 0.4)).toBeCloseTo(Z_MAX + 0.1, 9);
    expect(soft(Z_MIN - 0.2)).toBeCloseTo(Z_MIN - 0.05, 9);
    expect(clampZ(9)).toBe(Z_MAX);
    expect(clampZ(0.01)).toBe(Z_MIN);
  });

  it("the spring settles on its goal without ever passing it (critically damped)", () => {
    let s = { value: 1, v: 0 };
    let max = 1;
    for (let i = 0; i < 120; i++) {
      s = springStep(s.value, s.v, 2, 1 / 60);
      max = Math.max(max, s.value);
    }
    expect(s.value).toBeCloseTo(2, 3);
    expect(max).toBeLessThanOrEqual(2 + 1e-6);
  });

  it("a flick glides on and slows like a scroll view", () => {
    expect(decay(1000, 0)).toBe(1000);
    expect(decay(1000, 500)).toBeCloseTo(1000 * Math.pow(0.998, 500), 6);
    expect(projection(1000)).toBeCloseTo(499, 0);
  });

  it("a release speed from the last moments only; none if the pointer stopped first", () => {
    expect(
      releaseSpeed(
        [
          [0, 0, 0],
          [50, 100, 50],
        ],
        60,
      ),
    ).toEqual({ vx: 2000, vy: 1000 });
    expect(
      releaseSpeed(
        [
          [0, 0, 0],
          [50, 100, 50],
        ],
        200,
      ),
    ).toBeNull();
    expect(releaseSpeed([[0, 0, 0]], 10)).toBeNull();
  });

  it("fit shows the whole flow clear of the tools, never blown up past 115%", () => {
    const box = { x: 0, y: 0, w: 1000, h: 500 };
    const cam = fitCam(box, 1400, 800, { left: 64, right: 24, top: 24, bottom: 96 });
    // The flow's corners land inside the free area.
    expect(cam.x).toBeGreaterThanOrEqual(64 - 1e-6);
    expect(cam.x + box.w * cam.z).toBeLessThanOrEqual(1400 - 24 + 1e-6);
    expect(cam.y + box.h * cam.z).toBeLessThanOrEqual(800 - 96 + 1e-6);
    expect(fitCam({ x: 0, y: 0, w: 100, h: 80 }, 1400, 800, { left: 0, right: 0, top: 0, bottom: 0 }).z).toBe(
      1.15,
    );
  });

  it("reads a wheel: a pinch, a mouse's notches, or two fingers", () => {
    const e = { deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false, metaKey: false };
    expect(wheelKind({ ...e, deltaY: 3.5, ctrlKey: true })).toBe("pinch");
    expect(wheelKind({ ...e, deltaY: 100 })).toBe("wheel");
    expect(wheelKind({ ...e, deltaMode: 1, deltaY: 3 })).toBe("wheel");
    expect(wheelKind({ ...e, deltaY: 7.25 })).toBe("pan");
    expect(wheelKind({ ...e, deltaX: 12, deltaY: 40 })).toBe("pan");
  });
});
