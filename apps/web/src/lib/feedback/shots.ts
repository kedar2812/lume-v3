import type { ApiResult } from "@/lib/api";

/** Send feedback's sums and words (spec 2026-10-16 §1.2–§1.3, §4.1): pure, so they're tested without a canvas. */
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** In proportion, within `max` on the long edge, never larger than it was. */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

/** Best first; then lower quality; then 0.8 smaller each time, until under a quarter of the size. */
export function encodeSteps(): { scale: number; quality: number }[] {
  const steps = [
    { scale: 1, quality: 0.85 },
    { scale: 1, quality: 0.7 },
  ];
  for (let s = 0.8; s > 0.2; s *= 0.8) steps.push({ scale: Math.round(s * 1000) / 1000, quality: 0.7 });
  return steps;
}

export const normRect = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(b.x - a.x),
  h: Math.abs(b.y - a.y),
});

/** A box drawn on the preview, in the picture's own pixels. */
export function toImageRect(r: Rect, shown: { w: number; h: number }, image: { w: number; h: number }): Rect {
  const kx = image.w / shown.w;
  const ky = image.h / shown.h;
  return {
    x: Math.round(r.x * kx),
    y: Math.round(r.y * ky),
    w: Math.round(r.w * kx),
    h: Math.round(r.h * ky),
  };
}

/** The whole pixels a blur box touches, even partly, kept on a `w` × `h` picture; null when it misses it. */
export function burnBox(r: Rect, w: number, h: number): Rect | null {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(w, Math.ceil(r.x + r.w));
  const y2 = Math.min(h, Math.ceil(r.y + r.h));
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

/** Blocks at least 12 px, and an eighth of the box's short side: text under them can't be read back. */
export const blockSize = (r: Rect) => Math.max(12, Math.round(Math.min(r.w, r.h) / 8));

export function screenOf(win: Pick<Window, "innerWidth" | "innerHeight" | "devicePixelRatio">): string {
  const dpr = Math.round(win.devicePixelRatio * 100) / 100;
  return `${win.innerWidth} × ${win.innerHeight} · ${dpr}×`;
}

/** The theme the person is looking at: their choice, or the system's when they chose Auto. */
export function themeOf(doc: Document, systemDark: boolean): "porcelain" | "obsidian" {
  const t = doc.documentElement.dataset.theme;
  if (t === "obsidian" || t === "porcelain") return t;
  return systemDark ? "obsidian" : "porcelain";
}

const UNREACHABLE =
  "LUME couldn't reach its team just now. Your report is still here. Try again in a minute.";
const LICENCE = "This LUME's licence can't send feedback right now. Your report is still here.";
const IMAGE =
  "One screenshot can't be sent. Remove it or choose it again; the rest of your report is still here.";

/** The one line under the words when a report didn't go (spec 2026-10-16 §4.1). */
export function notSent(r: ApiResult<unknown>): { text: string; imageIndex?: number } {
  if (r.ok) return { text: "" };
  const details = (r.details ?? {}) as { retryAfterSec?: unknown; index?: unknown };
  if (r.code === "FEEDBACK_LIMITED") {
    const m = Math.max(1, Math.ceil((Number(details.retryAfterSec) || 3600) / 60));
    return {
      text: `That's a lot of reports in an hour, thank you. Try again in ${m === 1 ? "a minute" : `${m} minutes`}.`,
    };
  }
  if (r.code === "FEEDBACK_IMAGE_REFUSED") return { text: IMAGE, imageIndex: Number(details.index) || 0 };
  if (r.code === "FEEDBACK_LICENCE" || r.code === "NO_LICENCE_KEY") return { text: LICENCE };
  return { text: UNREACHABLE };
}
