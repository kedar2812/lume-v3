/**
 * The full-screen day's timeline maths (spec: Your day full screen), kept pure so each rule has its own test.
 * Positions are in px along the day; `pph` is px per hour.
 */

/** The most it zooms in: 100 px for every 15 minutes. */
export const MAX_PPH = 400;

/**
 * Which line each span goes on so that nothing touches: a span takes the first line whose last span ends at least
 * `gap` px before it starts, else a new line. Spans come in start order.
 */
export function packRows(spans: { x: number; w: number }[], gap = 8): number[] {
  const ends: number[] = [];
  return spans.map(({ x, w }) => {
    let row = ends.findIndex((end) => end + gap <= x);
    if (row < 0) row = ends.push(0) - 1;
    ends[row] = x + w;
    return row;
  });
}

/** Minutes between ruler ticks: every 2 h far out, every 30 min close in, hourly between. */
export function tickStep(pph: number): 30 | 60 | 120 {
  return pph < 70 ? 120 : pph > 260 ? 30 : 60;
}

/** Zoom stays between Fit day and MAX_PPH; a window wider than the whole day at MAX_PPH keeps Fit day. */
export function clampPph(pph: number, fitPph: number): number {
  return Math.max(fitPph, Math.min(MAX_PPH, pph));
}

/** The scroll position that keeps the time under `anchorX` (px from the scroller's left edge) where it was. */
export function zoomScroll(o: { scrollLeft: number; anchorX: number; pad: number; pph: number; next: number }): number {
  const hours = (o.scrollLeft + o.anchorX - o.pad) / o.pph;
  return hours * o.next + o.pad - o.anchorX;
}

/** How much further a flick at `v` px/s carries on before it stops (scroll-like deceleration). */
export function project(v: number, rate = 0.998): number {
  return ((v / 1000) * rate) / (1 - rate);
}

/** Past an end, the timeline follows less and less of the drag: `over` px of drag shows as this many. */
export function rubberband(over: number, dim: number, c = 0.55): number {
  return (over * dim * c) / (dim + c * Math.abs(over));
}
