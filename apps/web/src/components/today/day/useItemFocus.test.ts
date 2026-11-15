import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedPlace } from "./useItemFocus";

/** An element with a fixed on-screen box, in a window of a given size. */
const box = (left: number, top: number, width: number, height: number) =>
  ({
    getBoundingClientRect: () =>
      ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top }) as DOMRect,
  }) as HTMLElement;
const size = { w: window.innerWidth, h: window.innerHeight };
const windowOf = (w: number, h: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
};
/** The panel's box from its style (height as given). */
const rect = (s: ReturnType<typeof fixedPlace>, h: number, vh: number) => {
  const top = s.top != null ? Number(s.top) : vh - Number(s.bottom) - h;
  const left = Number(s.left);
  const height = s.maxHeight != null ? Math.min(h, Number(s.maxHeight)) : h;
  return { left, right: left + 264, top, bottom: top + height };
};
const overlaps = (a: { left: number; right: number; top: number; bottom: number }, el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return a.left < r.right && r.left < a.right && a.top < r.bottom && r.top < a.bottom;
};

describe("fixedPlace: the panel never sits on the thing it's about", () => {
  beforeEach(() => windowOf(1280, 800));
  afterEach(() => windowOf(size.w, size.h));

  it("beside on a desktop: to the right, top-aligned", () => {
    const el = box(300, 200, 180, 30);
    const s = fixedPlace(el, { side: "beside", height: 130 });
    expect(s.left).toBe(488);
    expect(overlaps(rect(s, 130, 800), el)).toBe(false);
  });

  it("beside on a phone, where neither side has room: below (or above) instead, clear of it", () => {
    windowOf(375, 760);
    for (const el of [box(100, 300, 160, 30), box(20, 700, 200, 30)]) {
      const s = fixedPlace(el, { side: "beside", height: 130 });
      expect(overlaps(rect(s, 130, 760), el)).toBe(false);
    }
  });

  it("a short window with no room above or below for all of it: it takes the larger side and scrolls", () => {
    windowOf(800, 380);
    const el = box(300, 170, 120, 30);
    const s = fixedPlace(el, { height: 300 });
    expect(s.maxHeight).toBeDefined();
    expect(s.overflowY).toBe("auto");
    expect(overlaps(rect(s, 300, 380), el)).toBe(false);
  });
});
