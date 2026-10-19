const UNITS = ["KB", "MB", "GB", "TB"] as const;

/**
 * A size as people read it (2026-10-19, the storage meter and its alert): "84 KB", "1.3 MB", "640 MB", "61 GB".
 * Binary units, as disks and phones show them; one decimal below 10, whole numbers from there. Anything that isn't a
 * size (negative, not a number) reads as 0 KB rather than something odd.
 */
export function bytesText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  let n = bytes / 1024;
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  const round = (x: number, u: number) => (u > 0 && x < 10 ? Math.round(x * 10) / 10 : Math.round(x));
  // 1023.9 MB rounds to 1024: say 1 GB instead.
  if (round(n, unit) >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${Math.max(unit === 0 ? 1 : 0, round(n, unit))} ${UNITS[unit]}`;
}
