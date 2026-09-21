const NAME_RE = /^lume-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z\.dump\.age$/;
const DAY = 86_400_000;

export function backupName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `lume-${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}T${p(at.getUTCHours())}${p(at.getUTCMinutes())}Z.dump.age`;
}

export function parseBackupTime(name: string): Date | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

/** Monday-based week number since the epoch (1970-01-05 was a Monday). */
const weekKey = (t: Date) => Math.floor((t.getTime() + 3 * DAY) / (7 * DAY));
const monthKey = (t: Date) => t.getUTCFullYear() * 12 + t.getUTCMonth();

/**
 * Report §12.7: keep 7 days of 6-hourly backups, the newest backup of each of the last 4 weeks,
 * and the newest of each of the last 6 months. Unrecognised files are never deleted.
 */
export function selectBackupsToDelete(names: string[], now: Date): string[] {
  const items = names
    .map((n) => ({ n, t: parseBackupTime(n) }))
    .filter((x): x is { n: string; t: Date } => x.t !== null)
    .sort((a, b) => b.t.getTime() - a.t.getTime());
  const keep = new Set<string>();
  for (const { n, t } of items) if (now.getTime() - t.getTime() <= 7 * DAY) keep.add(n);
  const newestPer = (key: (t: Date) => number, limit: number) => {
    const seen = new Set<number>();
    for (const { n, t } of items) {
      const k = key(t);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(n);
    }
  };
  newestPer(weekKey, 4);
  newestPer(monthKey, 6);
  return items.filter((x) => !keep.has(x.n)).map((x) => x.n);
}
