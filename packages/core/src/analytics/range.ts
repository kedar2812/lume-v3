import { wallTime } from "../tasks/time";

/**
 * Analytics ranges (spec §4, §4.3), in the business's own days. A range is a run of business days; `from` is the
 * first day's midnight there and `to` the midnight after the last (exclusive), as instants. The compare period is
 * the same number of days just before — except "this month so far", compared with the same day numbers of the
 * month before.
 */
export type RangePreset =
  "today" | "yesterday" | "7d" | "30d" | "90d" | "this_month" | "last_month" | "this_quarter" | "custom";
export type Span = { from: Date; to: Date; days: string[] };
export type Range = Span & { previous: Span; label: string };

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
const MAX_DAYS = 366;

const fmt = new Map<string, Intl.DateTimeFormat>();
/** The business day (YYYY-MM-DD) an instant falls on in `tz`. */
export function dayOf(at: Date, tz: string): string {
  let f = fmt.get(tz);
  if (!f)
    fmt.set(
      tz,
      (f = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })),
    );
  return f.format(at);
}

type Ymd = { y: number; m: number; d: number };
const parse = (s: string): Ymd => {
  const [y, m, d] = s.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
};
const iso = (t: Ymd) => `${t.y}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
const shift = (t: Ymd, days: number): Ymd => {
  const u = new Date(Date.UTC(t.y, t.m - 1, t.d + days));
  return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate() };
};
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const between = (a: Ymd, b: Ymd) =>
  Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);

function span(first: Ymd, last: Ymd, tz: string): Span {
  const n = between(first, last) + 1;
  const days = Array.from({ length: n }, (_, i) => iso(shift(first, i)));
  const end = shift(last, 1);
  return {
    from: wallTime(first.y, first.m, first.d, 0, 0, tz),
    to: wallTime(end.y, end.m, end.d, 0, 0, tz),
    days,
  };
}

/** "October 5", "October 1 – 3", "September 28 – October 4". */
function label(first: Ymd, last: Ymd): string {
  const a = `${MONTHS[first.m - 1]} ${first.d}`;
  if (between(first, last) === 0) return a;
  if (first.m === last.m && first.y === last.y) return `${a} – ${last.d}`;
  return `${a} – ${MONTHS[last.m - 1]} ${last.d}`;
}

export function resolveRange(
  preset: RangePreset,
  tz: string,
  now: Date,
  custom?: { from: string; to: string },
): Range {
  const today = parse(dayOf(now, tz));
  let first: Ymd;
  let last: Ymd = today;
  let previous: [Ymd, Ymd] | null = null;
  switch (preset) {
    case "today":
      first = today;
      break;
    case "yesterday":
      first = last = shift(today, -1);
      break;
    case "7d":
    case "30d":
    case "90d":
      first = shift(today, -(Number.parseInt(preset, 10) - 1));
      break;
    case "this_month": {
      first = { ...today, d: 1 };
      const pm = today.m === 1 ? { y: today.y - 1, m: 12 } : { y: today.y, m: today.m - 1 };
      previous = [
        { ...pm, d: 1 },
        { ...pm, d: Math.min(today.d, daysIn(pm.y, pm.m)) },
      ];
      break;
    }
    case "last_month": {
      const pm = today.m === 1 ? { y: today.y - 1, m: 12 } : { y: today.y, m: today.m - 1 };
      first = { ...pm, d: 1 };
      last = { ...pm, d: daysIn(pm.y, pm.m) };
      const pp = pm.m === 1 ? { y: pm.y - 1, m: 12 } : { y: pm.y, m: pm.m - 1 };
      previous = [
        { ...pp, d: 1 },
        { ...pp, d: daysIn(pp.y, pp.m) },
      ];
      break;
    }
    case "this_quarter":
      first = { y: today.y, m: Math.floor((today.m - 1) / 3) * 3 + 1, d: 1 };
      break;
    case "custom": {
      if (!custom) throw new Error("A custom range needs its days");
      first = parse(custom.from);
      last = parse(custom.to);
      if (between(first, last) < 0) throw new Error("The range ends before it starts");
      break;
    }
  }
  if (between(first, last) + 1 > MAX_DAYS) throw new Error("A range can run for a year at most");
  const n = between(first, last) + 1;
  const prev = previous ?? [shift(first, -n), shift(first, -1)];
  return { ...span(first, last, tz), previous: span(prev[0], prev[1], tz), label: label(first, last) };
}
