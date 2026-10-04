import type { RangePreset } from "@lume/core/shared";

/** The ranges the picker offers, as the canvas lists them (Analytics, Main: the range popover). */
export type RangeChoice =
  "today" | "7d" | "30d" | "this_month" | "last_month" | "this_quarter" | "12m" | "custom";
export const RANGE_CHOICES: { id: Exclude<RangeChoice, "custom">; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "this_quarter", label: "This quarter" },
  { id: "12m", label: "Last 12 months" },
];

const DAY = 86_400_000;
/** "2026-10-05" in the business's timezone. */
export const dayIn = (at: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
const parse = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plus = (d: string, n: number) => iso(new Date(parse(d).getTime() + n * DAY));
const between = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / DAY) + 1;
const monthName = (d: string, year = false) =>
  parse(d).toLocaleDateString("en-US", {
    month: "long",
    timeZone: "UTC",
    ...(year ? { year: "numeric" } : {}),
  });
const short = (d: string) =>
  parse(d).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** The first and last business day a choice covers, today included. */
export function daysOf(
  choice: RangeChoice,
  today: string,
  custom?: { from: string; to: string },
): [string, string] {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const first = (yy: number, mm: number) => iso(new Date(Date.UTC(yy, mm - 1, 1)));
  switch (choice) {
    case "today":
      return [today, today];
    case "7d":
      return [plus(today, -6), today];
    case "30d":
      return [plus(today, -29), today];
    case "this_month":
      return [first(y, m), today];
    case "last_month": {
      const start = first(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1);
      return [start, plus(first(y, m), -1)];
    }
    case "this_quarter":
      return [first(y, Math.floor((m - 1) / 3) * 3 + 1), today];
    case "12m":
      return [plus(today, -364), today];
    case "custom":
      return custom ? [custom.from, custom.to] : [plus(today, -29), today];
  }
}

/** What the button says, and the period it compares with ("Last 30 days", "vs the 30 before"). */
export function rangeWords(choice: RangeChoice, today: string, custom?: { from: string; to: string }) {
  const [from, to] = daysOf(choice, today, custom);
  const n = between(from, to);
  const span = (a: string, b: string) =>
    a === b
      ? short(a)
      : a.slice(0, 7) === b.slice(0, 7)
        ? `${short(a)} – ${Number(b.slice(8))}`
        : `${short(a)} – ${short(b)}`;
  switch (choice) {
    case "today":
      return { label: "Today", vs: "vs yesterday" };
    case "7d":
      return { label: "Last 7 days", vs: "vs the 7 before" };
    case "30d":
      return { label: "Last 30 days", vs: "vs the 30 before" };
    case "this_month": {
      const prevFrom = daysOf("last_month", today)[0];
      return { label: span(from, to), vs: `vs ${span(prevFrom, plus(prevFrom, n - 1))}` };
    }
    case "last_month":
      return { label: monthName(from), vs: `vs ${monthName(plus(from, -1))}` };
    case "this_quarter":
      return { label: span(from, to), vs: "vs the quarter before" };
    case "12m":
      return { label: "Last 12 months", vs: "vs the 12 before" };
    case "custom":
      return { label: span(from, to), vs: `vs the ${n === 1 ? "day" : `${n} days`} before` };
  }
}

/** The query the API takes for a choice: its own preset where it has one, else the days themselves. */
export function apiRange(choice: RangeChoice, today: string, custom?: { from: string; to: string }) {
  if (choice === "12m" || choice === "custom") {
    const [from, to] = daysOf(choice, today, custom);
    return { range: "custom" as RangePreset, from, to };
  }
  return { range: choice as RangePreset };
}

/** A month drawn Monday first: 6 weeks of days, each with whether it's in that month. */
export function monthGrid(month: string): { day: string; inMonth: boolean }[] {
  const first = parse(`${month.slice(0, 7)}-01`);
  const lead = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime() - lead * DAY);
  return Array.from({ length: 42 }, (_, i) => {
    const d = iso(new Date(start.getTime() + i * DAY));
    return { day: d, inMonth: d.slice(0, 7) === month.slice(0, 7) };
  });
}
export const monthTitle = (month: string) => monthName(`${month.slice(0, 7)}-01`, true);
export const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return iso(new Date(Date.UTC(y, m - 1 + by, 1)));
};
/** The most a range may cover (the API's own limit). */
export const MAX_RANGE_DAYS = 366;
export const daysBetween = between;
