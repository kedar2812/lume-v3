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

/** The smallest 1, 2 or 5 times a power of ten that is at least `v`. */
const niceStep = (v: number) => {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
};

/** An axis's ticks: 0 up to a round top at least `max`, in at most five steps of 1, 2 or 5 × 10ⁿ. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const step = niceStep(max / 5);
  const top = Math.ceil(max / step - 1e-9) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

/**
 * A tile's sparkline from its daily values: nothing under three real days; a day with nothing to divide takes its
 * neighbours' value; past two weeks a three-day mean, past four a seven-day one, so one busy day isn't a spike.
 */
export function sparkLine(values: (number | null)[]): number[] | null {
  const real = values.flatMap((v, i) => (v === null ? [] : [[i, v] as const]));
  if (real.length < 3) return null;
  const filled = values.map((v, i) => {
    if (v !== null) return v;
    const before = real.findLast(([j]) => j < i);
    const after = real.find(([j]) => j > i);
    if (!before) return after![1];
    if (!after) return before[1];
    return before[1] + ((after[1] - before[1]) * (i - before[0])) / (after[0] - before[0]);
  });
  if (filled.length < 14) return filled;
  const half = filled.length >= 28 ? 3 : 1;
  return filled.map((_, i) => {
    const w = filled.slice(Math.max(0, i - half), i + half + 1);
    return w.reduce((a, x) => a + x, 0) / w.length;
  });
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
