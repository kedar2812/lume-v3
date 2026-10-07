import { dayKey } from "@/lib/dates";

const hourIn = (d: Date, tz: string) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(d));

/**
 * When the new leads started arriving, in the person's own day ("12 new since this morning"): this morning or
 * earlier today, yesterday, a weekday within the week, then a short date — all on their clock, not the browser's.
 */
export function sinceWords(iso: string, tz: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.round(
    (Date.parse(`${dayKey(now, tz)}T00:00:00Z`) - Date.parse(`${dayKey(d, tz)}T00:00:00Z`)) / 86_400_000,
  );
  if (days <= 0) return hourIn(d, tz) < 12 ? "this morning" : "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d);
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(d);
}
