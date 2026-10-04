/**
 * The photo cropper (7C, canvas Profile), as numbers: a square frame the photo always covers, moved by hand with
 * soft edges, carried on by a flick, settling in the middle when close, zoomed and turned — and the square of the
 * photo that ends up kept. Offsets are the photo's centre from the frame's centre, in screen px.
 */
export type Size = { w: number; h: number };
export type Turn = 0 | 90 | 180 | 270;
export type Offset = { x: number; y: number };

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;

/** The photo's sides once turned a quarter or three. */
export const turned = (s: Size, turn: Turn): Size => (turn % 180 ? { w: s.h, h: s.w } : s);

/** The scale at which the photo's shorter side fills the frame exactly. */
export const coverScale = (s: Size, frame: number) => frame / Math.min(s.w, s.h);

/** How far the photo's centre may move from the frame's centre, each way, and still cover it. */
export function bounds(s: Size, frame: number, zoom: number): Offset {
  const k = coverScale(s, frame) * zoom;
  return { x: Math.max(0, (s.w * k - frame) / 2), y: Math.max(0, (s.h * k - frame) / 2) };
}

export const clampOffset = (o: Offset, b: Offset): Offset => ({
  x: Math.min(b.x, Math.max(-b.x, o.x)),
  y: Math.min(b.y, Math.max(-b.y, o.y)),
});

/** Past an edge, the photo follows less the further it goes (Apple's rubber band). */
export function rubber(overshoot: number, dimension: number, c = 0.55): number {
  return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
}

/** One axis while dragging: free inside the bounds, rubber-banded past them. */
export function dragAxis(v: number, limit: number, frame: number): number {
  if (v > limit) return limit + rubber(v - limit, frame);
  if (v < -limit) return -limit + rubber(v + limit, frame);
  return v;
}

/** Where a flick at `velocity` px/s comes to rest, as scrolling does (decelerationRate 0.998). */
export const project = (velocity: number, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate);

/** Within a few px of the middle, settle exactly there. */
export const magnet = (v: number, pull = 6) => (Math.abs(v) < pull ? 0 : v);

/** The square of the (turned) photo the frame shows, in the photo's own pixels. */
export function cropRect(
  s: Size,
  frame: number,
  zoom: number,
  o: Offset,
): { x: number; y: number; size: number } {
  const k = coverScale(s, frame) * zoom;
  const size = frame / k;
  return { x: (s.w * k - frame) / 2 / k - o.x / k, y: (s.h * k - frame) / 2 / k - o.y / k, size };
}

/**
 * Draws the kept square into a `px`-sized canvas: the photo turned, then cropped. Used for the live previews and for
 * the 256 px picture that's uploaded, so what's shown is exactly what's kept.
 */
export function drawCrop(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { naturalWidth: number; naturalHeight: number },
  turn: Turn,
  frame: number,
  zoom: number,
  o: Offset,
  px: number,
) {
  const natural = { w: img.naturalWidth, h: img.naturalHeight };
  const t = turned(natural, turn);
  const r = cropRect(t, frame, zoom, o);
  const k = px / r.size;
  ctx.save();
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, px, px);
  ctx.translate(-r.x * k, -r.y * k);
  ctx.translate((t.w * k) / 2, (t.h * k) / 2);
  ctx.rotate((turn * Math.PI) / 180);
  ctx.drawImage(img, (-natural.w * k) / 2, (-natural.h * k) / 2, natural.w * k, natural.h * k);
  ctx.restore();
}
