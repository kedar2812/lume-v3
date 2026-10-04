/**
 * Durations kept as histograms in the rollups (spec §5.1), so a median or a P75 over any range and any mix of people
 * comes from adding counts, never from re-reading every lead. Twelve buckets, log-spaced in minutes; within a bucket
 * a quantile is read linearly. The last bucket is open-ended: a quantile landing there reads as its lower edge.
 */
export const DURATION_EDGES = [0, 5, 15, 30, 60, 120, 240, 480, 1440, 2880, 4320, 10080] as const; // minutes
export const BUCKETS = DURATION_EDGES.length;

/** The bucket a duration (minutes) falls in. */
export function bucketOf(minutes: number): number {
  let i = 0;
  while (i + 1 < BUCKETS && minutes >= DURATION_EDGES[i + 1]!) i++;
  return i;
}

/** Adds histograms bucket by bucket. */
export const addHist = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] ?? 0));

/** The q-quantile (0–1) of a histogram, in minutes; null when it holds nothing. */
export function quantileFromHist(counts: readonly number[], q: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = q * total;
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const c = counts[i] ?? 0;
    if (c && seen + c >= target) {
      const lo = DURATION_EDGES[i]!;
      if (i === BUCKETS - 1) return lo;
      const hi = DURATION_EDGES[i + 1]!;
      return lo + ((target - seen) / c) * (hi - lo);
    }
    seen += c;
  }
  return DURATION_EDGES[BUCKETS - 1]!;
}

/** The exact median of a list (for live queries and the fixture's own answers). */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
