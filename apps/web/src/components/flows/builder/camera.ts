/**
 * The flow builder's camera (approved canvas KJJDFJ7wddubXwRuked4m9, board Builder; owner 2026-11-23: "the navigation
 * and zoom in zoom out ... has to be super smooth"). Pure math, so it's tested on its own; useCamera drives it.
 *
 * Dragging tracks the pointer 1:1 and keeps its momentum when let go (decay 0.998 a millisecond, as a scroll view);
 * a pinch or Ctrl/⌘-scroll zooms 1:1 about the cursor, soft past the limits; a mouse wheel's notches, the buttons, Fit
 * and the keys spring there, critically damped (response 0.38 s), so nothing overshoots or jumps. Every motion starts
 * from where the canvas is on screen, so a new touch can always take over.
 */

/** Where the canvas is: x, y in screen pixels of the canvas's origin, z its scale. */
export type Cam = { x: number; y: number; z: number };
/** A rectangle in canvas units. */
export type Box = { x: number; y: number; w: number; h: number };

export const Z_MIN = 0.3;
export const Z_MAX = 2.4;
/** Momentum's decay per millisecond. */
export const DECAY = 0.998;
/** The spring's response in seconds (damping 1: no overshoot). */
export const RESPONSE = 0.38;
/** A glide slower than this (px/s) stops. */
export const GLIDE_STOP = 8;
/** A press that moves less than this is a click, not a drag. */
export const DRAG_SLOP = 4;

/** Past the limits the zoom gives a quarter as much: a soft edge a pinch can push into, which springs back. */
export const soft = (z: number) =>
  z > Z_MAX ? Z_MAX + (z - Z_MAX) * 0.25 : z < Z_MIN ? Z_MIN - (Z_MIN - z) * 0.25 : z;
export const clampZ = (z: number) => Math.min(Z_MAX, Math.max(Z_MIN, z));

/** The camera at zoom `z`, with the canvas point under screen point (px, py) still under it. */
export function zoomAbout(cam: Cam, z: number, px: number, py: number): Cam {
  const wx = (px - cam.x) / cam.z;
  const wy = (py - cam.y) / cam.z;
  return { x: px - wx * z, y: py - wy * z, z };
}

/** A screen point as a canvas point. */
export const toCanvas = (cam: Cam, px: number, py: number) => ({
  x: (px - cam.x) / cam.z,
  y: (py - cam.y) / cam.z,
});

const W = (2 * Math.PI) / RESPONSE;
const K = W * W;
const C = 2 * W;

/** One step of a critically damped spring from `value` (moving at `v`) towards `goal`, `dt` seconds long. */
export function springStep(value: number, v: number, goal: number, dt: number): { value: number; v: number } {
  const a = -K * (value - goal) - C * v;
  const nv = v + a * dt;
  return { value: value + nv * dt, v: nv };
}

/** Momentum after `ms` milliseconds: the speed left, as a scroll view slows. */
export const decay = (speed: number, ms: number) => speed * Math.pow(DECAY, ms);

/** How far a glide at `speed` px/s goes before it stops (what a flick projects to). */
export const projection = (speed: number) => ((speed / 1000) * DECAY) / (1 - DECAY);

/**
 * The camera that shows `box` whole inside a view `vw` × `vh`, clear of `inset` on each side, never closer than
 * `maxZ` (a small flow isn't blown up).
 */
export function fitCam(
  box: Box,
  vw: number,
  vh: number,
  inset: { left: number; right: number; top: number; bottom: number },
  maxZ = 1.15,
): Cam {
  const aw = Math.max(1, vw - inset.left - inset.right);
  const ah = Math.max(1, vh - inset.top - inset.bottom);
  const z = clampZ(Math.min(aw / Math.max(1, box.w), ah / Math.max(1, box.h), maxZ));
  return {
    x: inset.left + (aw - box.w * z) / 2 - box.x * z,
    y: inset.top + (ah - box.h * z) / 2 - box.y * z,
    z,
  };
}

/** A pointer's recent path → its release speed in px/s (the last 90 ms; none if it stopped before letting go). */
export function releaseSpeed(
  hist: [t: number, x: number, y: number][],
  now: number,
): { vx: number; vy: number } | null {
  if (hist.length < 2) return null;
  const [t0, x0, y0] = hist[0]!;
  const [t1, x1, y1] = hist[hist.length - 1]!;
  if (now - t1 > 60) return null;
  const ms = Math.max(1, t1 - t0);
  return { vx: ((x1 - x0) / ms) * 1000, vy: ((y1 - y0) / ms) * 1000 };
}

/** What a wheel event means: a pinch (or Ctrl/⌘ and scroll), a mouse wheel's notches, or two fingers moving. */
export function wheelKind(e: {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}): "pinch" | "wheel" | "pan" {
  if (e.ctrlKey || e.metaKey) return "pinch";
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  if (e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(dy) >= 40 && Number.isInteger(dy))) return "wheel";
  return "pan";
}
