/**
 * The statistics behind "LUME noticed" (spec §6.1): a detector speaks only when a difference is real, not noise.
 * Proportions use a two-proportion z-test (two-sided); small groups are bounded with a Wilson interval.
 */

/** The standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Two-sided test that two rates differ: a of n1 against b of n2. p is 1 when either group is empty. */
export function twoProportion(a: number, n1: number, b: number, n2: number): { z: number; p: number } {
  if (!n1 || !n2) return { z: 0, p: 1 };
  const p1 = a / n1;
  const p2 = b / n2;
  const pooled = (a + b) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, p: p1 === p2 ? 1 : 0 };
  const z = (p1 - p2) / se;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

/** The Wilson score interval for k of n (95% by default). */
export function wilson(k: number, n: number, z = 1.959964): [number, number] {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export const SIGNIFICANT = 0.05;
