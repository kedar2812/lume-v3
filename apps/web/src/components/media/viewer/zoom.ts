/*
 * What the photo viewer's zoom is made of (owner, 2026-10-25: "all zoom features that are available in the photos
 * app"): telling a mouse's wheel from a trackpad, a click from a drag, soft edges, and where a flick comes to rest.
 */

type Wheel = { deltaMode: number; deltaX: number; deltaY: number; wheelDeltaY?: number };

/**
 * A mouse's wheel, not a trackpad: it moves in whole lines (Firefox), or in notches the browser counts as 120 each.
 * A trackpad sends small steps, often sideways too. A browser that says neither: only a big, straight step is a wheel.
 */
export function isMouseWheel(e: Wheel): boolean {
  if (e.deltaMode !== 0) return true;
  if (e.deltaX !== 0) return false;
  if (typeof e.wheelDeltaY === "number" && e.wheelDeltaY !== 0) return e.wheelDeltaY % 120 === 0;
  return Math.abs(e.deltaY) >= 50;
}

/** A press that let go within 6 px and quickly: a click, not the start of a pan. */
export function isClick(down: { x: number; y: number; t: number }, up: { x: number; y: number; t: number }) {
  return Math.hypot(up.x - down.x, up.y - down.y) < 6 && up.t - down.t < 350;
}

/** Past an edge, the further it's pulled the less it follows (Apple's rubber band). */
export function rubberband(over: number, dimension: number, c = 0.55): number {
  if (over === 0) return 0;
  const a = Math.abs(over);
  return Math.sign(over) * ((a * dimension * c) / (dimension + c * a));
}

/** A value held softly between lo and hi: inside, as it is; outside, rubber-banded over `dimension`. */
export function softClamp(v: number, lo: number, hi: number, dimension: number): number {
  if (v > hi) return hi + rubberband(v - hi, dimension);
  if (v < lo) return lo + rubberband(v - lo, dimension);
  return v;
}

/** Where a flick at `velocity` (px/s) comes to rest, as a scroll view decelerates (Apple's projection). */
export function project(velocity: number, rate = 0.998): number {
  return ((velocity / 1000) * rate) / (1 - rate);
}
