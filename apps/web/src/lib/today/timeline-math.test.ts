import { describe, expect, it } from "vitest";
import { clampPph, packRows, project, rubberband, tickStep, zoomScroll } from "./timeline-math";

describe("packRows: things that would touch go onto the next line", () => {
  it("three spans: the second overlaps the first, the third has room on the first line", () => {
    expect(
      packRows([
        { x: 0, w: 100 },
        { x: 10, w: 100 },
        { x: 300, w: 100 },
      ]),
    ).toEqual([0, 1, 0]);
  });

  it("respects the gap: 8 px between the end of one and the start of the next", () => {
    expect(
      packRows([
        { x: 0, w: 100 },
        { x: 105, w: 50 },
      ]),
    ).toEqual([0, 1]);
    expect(
      packRows([
        { x: 0, w: 100 },
        { x: 108, w: 50 },
      ]),
    ).toEqual([0, 0]);
  });

  it("nothing on a line ever overlaps, whatever the order of widths", () => {
    const spans = Array.from({ length: 80 }, (_, i) => ({ x: (i * 37) % 900, w: 60 + ((i * 53) % 140) })).sort(
      (a, b) => a.x - b.x,
    );
    const rows = packRows(spans);
    for (let i = 0; i < spans.length; i++)
      for (let j = i + 1; j < spans.length; j++)
        if (rows[i] === rows[j]) {
          const [a, b] = [spans[i]!, spans[j]!];
          expect(a.x + a.w + 8 <= b.x || b.x + b.w + 8 <= a.x).toBe(true);
        }
  });

  it("packs 300 in under 30 ms (300 follow-ups at the same minute)", () => {
    const spans = Array.from({ length: 300 }, () => ({ x: 500, w: 220 }));
    const t = performance.now();
    const rows = packRows(spans);
    expect(performance.now() - t).toBeLessThan(30);
    expect(new Set(rows).size).toBe(300);
  });
});

describe("the ruler", () => {
  it("ticks every 2 h far out, hourly in the middle, every 30 min close in", () => {
    expect(tickStep(60)).toBe(120);
    expect(tickStep(140)).toBe(60);
    expect(tickStep(300)).toBe(30);
  });
});

describe("zoom", () => {
  it("stays between Fit day and 400 px an hour", () => {
    expect(clampPph(30, 50)).toBe(50);
    expect(clampPph(900, 50)).toBe(400);
    expect(clampPph(200, 50)).toBe(200);
  });

  it("a window wider than a whole day at 400 px an hour still fits the day", () => {
    expect(clampPph(500, 450)).toBe(450);
  });

  it("zoomScroll keeps the time under the pointer where it was", () => {
    const pad = 40;
    const before = { scrollLeft: 700, anchorX: 400, pad, pph: 140 };
    const timeAt = (scrollLeft: number, pph: number) => (scrollLeft + before.anchorX - pad) / pph;
    const next = 189;
    const left = zoomScroll({ ...before, next });
    expect(timeAt(left, next)).toBeCloseTo(timeAt(before.scrollLeft, before.pph), 9);
  });
});

describe("drag physics", () => {
  it("a flick carries on: 1000 px/s lands about 499 px further", () => {
    expect(project(1000)).toBeCloseTo(499, 0);
    expect(project(-1000)).toBeCloseTo(-499, 0);
    expect(project(0)).toBe(0);
  });

  it("past the ends it gives less than the drag and levels off below the window's size", () => {
    const dim = 800;
    for (const over of [10, 100, 1000, 10_000]) {
      const r = rubberband(over, dim);
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThan(over);
      expect(r).toBeLessThan(dim);
    }
    expect(rubberband(-100, dim)).toBeCloseTo(-rubberband(100, dim), 9);
    expect(rubberband(0, dim)).toBe(0);
  });
});
