/**
 * Chart geometry for analytics (8C): points in an SVG box, a smooth line through them, the area under it, and the
 * bands of a stacked chart. Pure numbers, so the shapes are tested, not eyeballed.
 */
export type Pt = [number, number];

/** A nice round top for an axis: 1, 2 or 5 times a power of ten, at least `v`. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Values spread across a box `w` wide, `h` high (y down), with `pad` inside. */
export function toPts(values: number[], w: number, h: number, max: number, pad = 0): Pt[] {
  const n = values.length;
  const step = n > 1 ? (w - pad * 2) / (n - 1) : 0;
  return values.map((v, i) => [pad + i * step, pad + (h - pad * 2) * (1 - (max ? v / max : 0))]);
}

/** A smooth path through the points (monotone cubic, so it never overshoots a value). */
export function smooth(pts: Pt[]): string {
  if (!pts.length) return "";
  if (pts.length === 1) return `M${f(pts[0]![0])},${f(pts[0]![1])}`;
  const n = pts.length;
  const dx = (i: number) => pts[i + 1]![0] - pts[i]![0];
  const slope = (i: number) => (pts[i + 1]![1] - pts[i]![1]) / (dx(i) || 1);
  const m: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) m.push(slope(0));
    else if (i === n - 1) m.push(slope(n - 2));
    else {
      const a = slope(i - 1);
      const b = slope(i);
      m.push(a * b <= 0 ? 0 : (a + b) / 2);
    }
  }
  let d = `M${f(pts[0]![0])},${f(pts[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx(i) / 3;
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    d += ` C${f(x0 + h)},${f(y0 + m[i]! * h)} ${f(x1 - h)},${f(y1 - m[i + 1]! * h)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

/** The area between a line and the bottom of the box. */
export function areaUnder(pts: Pt[], h: number): string {
  if (!pts.length) return "";
  return `${smooth(pts)} L${f(pts.at(-1)![0])},${f(h)} L${f(pts[0]![0])},${f(h)} Z`;
}

/** One band of a stacked chart: from its top line back along the band below it. */
export function band(top: Pt[], below: Pt[]): string {
  if (!top.length) return "";
  const back = [...below].reverse();
  return `${smooth(top)} L${f(back[0]![0])},${f(back[0]![1])} ${smooth(back).replace(/^M[^ ]+/, "")} Z`;
}

const f = (v: number) => (Math.round(v * 10) / 10).toString();
