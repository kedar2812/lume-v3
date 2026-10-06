/**
 * What a month-to-date number is set against, said exactly: the same days of last month ("vs Sep 1–5"), so the 5th
 * never reads as a fall against a whole month.
 */
export function sameDaysLastMonth(today: string): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const days = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const name = prev.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const last = Math.min(d, days);
  return last === 1 ? `vs ${name} 1` : `vs ${name} 1–${last}`;
}
