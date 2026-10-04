/**
 * How far through a business month `now` is, the way goals count it (8B): its days up to and including today are
 * gone. One rule for every "at this pace": goals, revenue this month, a rep's own view, and LUME noticed.
 */
export function monthProgress(now: Date, tz: string, monthStart?: string) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now); // YYYY-MM-DD
  const first = monthStart ?? `${today.slice(0, 8)}01`;
  const [y, m] = first.split("-").map(Number) as [number, number];
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const gone = Math.min(
    inMonth,
    Math.max(0, Math.round((Date.parse(today) - Date.parse(first)) / 86_400_000) + 1),
  );
  return {
    first,
    today,
    inMonth,
    gone,
    elapsed: gone / inMonth,
    daysLeft: inMonth - gone,
    name: new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(y, m - 1, 1)),
    ),
  };
}
