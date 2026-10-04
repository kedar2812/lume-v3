/**
 * How far through a business month `now` is, the way goals count it (8B): its days up to and including today are
 * gone. One rule for every "at this pace": goals, revenue this month, a rep's own view, and LUME noticed.
 */
/**
 * The days a month's goal counts, for the range on screen: the month the range ends in, from its first day to today,
 * or to its last day once it's over. A goal is the month's whatever days the screen shows.
 */
export function goalMonth(rangeLast: string, today: string): { from: string; to: string } {
  const from = `${rangeLast.slice(0, 8)}01`;
  const [y, m] = from.split("-").map(Number) as [number, number];
  const last = `${from.slice(0, 8)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const to = last < today ? last : today;
  return { from, to: to < from ? from : to };
}

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
