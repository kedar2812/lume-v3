import { describe, expect, it } from "vitest";
import { bounds, clampOffset, coverScale, cropRect, magnet, project, rubber, turned } from "./crop";

const F = 280; // the frame, px

describe("the photo cropper's maths (7C)", () => {
  it("a turned photo swaps its sides, and the photo always covers the frame", () => {
    expect(turned({ w: 1200, h: 800 }, 90)).toEqual({ w: 800, h: 1200 });
    expect(turned({ w: 1200, h: 800 }, 180)).toEqual({ w: 1200, h: 800 });
    expect(coverScale({ w: 1200, h: 800 }, F)).toBeCloseTo(F / 800);
  });

  it("can be moved only as far as it still covers the frame, more when zoomed in", () => {
    const b1 = bounds({ w: 1200, h: 800 }, F, 1);
    expect(b1.x).toBeCloseTo((1200 * (F / 800) - F) / 2);
    expect(b1.y).toBe(0);
    const b2 = bounds({ w: 1200, h: 800 }, F, 2);
    expect(b2.y).toBeCloseTo(F / 2);
    expect(clampOffset({ x: 999, y: -999 }, b2)).toEqual({ x: b2.x, y: -b2.y });
  });

  it("past an edge it gives less and less, like something real", () => {
    expect(rubber(0, F)).toBe(0);
    const a = rubber(50, F);
    const b = rubber(200, F);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(50);
    expect(b - a).toBeLessThan(150);
    expect(rubber(-50, F)).toBeCloseTo(-a);
  });

  it("a flick carries on where it was going; near the centre it settles exactly in the middle", () => {
    expect(project(0)).toBe(0);
    expect(project(1000)).toBeGreaterThan(project(500));
    expect(magnet(4)).toBe(0);
    expect(magnet(-5)).toBe(0);
    expect(magnet(9)).toBe(9);
  });

  it("the square kept is exactly what the frame shows", () => {
    // Centred, not zoomed: the middle square of a landscape photo.
    expect(cropRect({ w: 1200, h: 800 }, F, 1, { x: 0, y: 0 })).toEqual({ x: 200, y: 0, size: 800 });
    // Zoomed 2× and moved right by 70 px on screen: the frame sees further left in the photo.
    const r = cropRect({ w: 1200, h: 800 }, F, 2, { x: 70, y: 0 });
    expect(r.size).toBeCloseTo(400);
    expect(r.x).toBeCloseTo(400 - 70 / ((F / 800) * 2));
    expect(r.y).toBeCloseTo(200);
  });
});
