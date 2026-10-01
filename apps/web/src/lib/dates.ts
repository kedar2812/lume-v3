/**
 * Dates the way LUME says them (owner, 2026-10-01): month first, then the day of the week —
 * "October 1, Thursday", "Oct 1, Thu", "Oct 1, Thu, 2:30 pm" — always on the business's clock, whatever
 * zone the browser is in. Near days are words: Today, Tomorrow, Yesterday.
 */

type Parts = { year: number; month: number; day: number; weekday: number; hour: number; minute: number };

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsOf(d: Date, tz: string): Parts {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    weekday: WEEKDAY[p.weekday!]!,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
}

/** "October 1, Thursday". */
export function longDate(d: Date, tz: string): string {
  const p = partsOf(d, tz);
  return `${MONTHS[p.month - 1]} ${p.day}, ${DAYS[p.weekday]}`;
}

/** "Oct 1, Thu". */
export function shortDate(d: Date, tz: string): string {
  const p = partsOf(d, tz);
  return `${MONTHS[p.month - 1]!.slice(0, 3)} ${p.day}, ${DAYS[p.weekday]!.slice(0, 3)}`;
}

/** "2:30 pm", "9 am", and "12 pm" / "12 am" on the hour — the same words LUME's messages use. */
export function timeOf(d: Date, tz: string): string {
  const { hour, minute } = partsOf(d, tz);
  const h12 = ((hour + 11) % 12) + 1;
  return `${h12}${minute ? `:${String(minute).padStart(2, "0")}` : ""} ${hour >= 12 ? "pm" : "am"}`;
}

/** "Oct 1, Thu, 2:30 pm". */
export function dateTime(d: Date, tz: string): string {
  return `${shortDate(d, tz)}, ${timeOf(d, tz)}`;
}

/** The calendar day on the business's clock, as YYYY-MM-DD. */
export function dayKey(d: Date, tz: string): string {
  const p = partsOf(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Whole days from one day key to another (each a calendar date, so no clock or DST enters it). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / 86_400_000);
}
function ymd(k: string): [number, number, number] {
  const [y, m, d] = k.split("-").map(Number) as [number, number, number];
  return [y, m - 1, d];
}

/** A day key moved by n days. */
export function addDays(k: string, n: number): string {
  const t = new Date(Date.UTC(...ymd(k)) + n * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** Today, Tomorrow or Yesterday on the business's clock; any other day in full. */
export function nearDay(d: Date, tz: string, now: Date = new Date()): string {
  const diff = daysBetween(dayKey(now, tz), dayKey(d, tz));
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return longDate(d, tz);
}

/** The seven day keys of the week holding `k`, starting on the business's first day of the week. */
export function weekOf(k: string, weekStart: "monday" | "sunday"): string[] {
  const dow = new Date(Date.UTC(...ymd(k))).getUTCDay();
  const back = weekStart === "monday" ? (dow + 6) % 7 : dow;
  const first = addDays(k, -back);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}
