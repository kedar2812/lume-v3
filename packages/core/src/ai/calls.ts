import { addLocalDays, wallClock, wallMinute } from "../tasks/time";

/**
 * The calls LUME AI may say yes to (spec 2026-11-02 LUME AI books calls): the times the business gave it, on its own
 * clock. Pure: the engine reads the speaker's meetings and books in one locked step; this only says whether a time fits.
 */

/** Days (0 = Sunday) and a from–to on the business's clock ("16:00" to "19:00"). */
export type CallWindow = { days: number[]; from: string; to: string };
export type CallRules = {
  windows: CallWindow[];
  /** How long a call is, in minutes. */
  minutes: number;
  /** At least this many hours from now. */
  noticeHours: number;
  /** At most this many days ahead, on the business's calendar (today is day 0). */
  daysAhead: number;
  /** How the call happens, in the business's words ("We'll call you on this number"). */
  how: string;
  /**
   * LUME makes a Google Meet link for each call (spec 2026-11-03): the call goes into the speaker's Google Calendar and
   * LUME AI's yes carries the link. Absent on profiles saved before it: off.
   */
  meet?: boolean;
};
export const CALL_MINUTES = [15, 30, 45, 60] as const;
export const DEFAULT_CALL_RULES: CallRules = {
  windows: [],
  minutes: 30,
  noticeHours: 2,
  daysAhead: 14,
  how: "",
  meet: false,
};

/** The speaker's meetings that aren't cancelled: a call never overlaps one. */
export type Busy = { start: Date; end: Date };
export type SlotProblem = "outside" | "soon" | "far" | "taken";
type Check = { rules: CallRules; tz: string; now: Date; busy: Busy[] };

const MIN = 60_000;
const minuteOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};
/** Whole local days from `a` to `b`. */
const daysBetween = (a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }) =>
  Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);

/**
 * Why a call can't start at `start`, or null when LUME AI may say yes to it: inside one of the windows (the whole call),
 * at least the notice ahead, no further than the days ahead, and clear of the speaker's meetings.
 */
export function slotProblem(start: Date, o: Check): SlotProblem | null {
  if (start.getTime() % MIN !== 0) return "outside";
  const end = new Date(start.getTime() + o.rules.minutes * MIN);
  const c = wallClock(start, o.tz);
  const from = c.hh * 60 + c.mm;
  // The end read on the same day's clock: a call can't run past midnight or across a clock change unnoticed.
  const fits = o.rules.windows.some(
    (w) =>
      w.days.includes(c.weekday) &&
      from >= minuteOf(w.from) &&
      wallMinute(c, minuteOf(w.to), o.tz).getTime() >= end.getTime(),
  );
  if (!fits) return "outside";
  if (start.getTime() < o.now.getTime() + o.rules.noticeHours * 60 * MIN) return "soon";
  if (daysBetween(wallClock(o.now, o.tz), c) > o.rules.daysAhead) return "far";
  if (o.busy.some((b) => b.start < end && b.end > start)) return "taken";
  return null;
}

/** The first free start in each day's windows, soonest first, up to `max`: the times LUME AI may offer. */
export function freeCallTimes(o: Check, max: number): Date[] {
  const today = wallClock(o.now, o.tz);
  const out: Date[] = [];
  const windows = [...o.rules.windows].sort((a, b) => minuteOf(a.from) - minuteOf(b.from));
  for (let k = 0; k <= o.rules.daysAhead && out.length < max; k++) {
    const day = addLocalDays(today, k);
    const weekday = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
    for (const w of windows) {
      if (!w.days.includes(weekday) || out.length >= max) continue;
      for (let m = minuteOf(w.from); m + o.rules.minutes <= minuteOf(w.to); m += o.rules.minutes) {
        const at = wallMinute(day, m, o.tz);
        if (slotProblem(at, o) === null) {
          if (!out.some((x) => x.getTime() === at.getTime())) out.push(at);
          break;
        }
      }
    }
  }
  return out;
}

/**
 * The call hours as the time guard reads a message (review 2026-11-04): each quarter hour from each window's start to
 * its end, each way people write one, and the days and dates ahead that have hours. Cheap, with no calendar check per
 * slot: the guard matches times of day, and the booking checks the real slot under the speaker's lock.
 */
export function callHourWords(o: Check): string {
  const out = new Set<string>();
  for (const w of o.rules.windows)
    for (let m = minuteOf(w.from); m <= minuteOf(w.to); m += 15) {
      const hh = Math.floor(m / 60);
      const mm = m % 60;
      const ampm = hh < 12 ? "am" : "pm";
      if (mm === 0) out.add(`${twelve(hh)}${ampm}`);
      out.add(`${twelve(hh)}:${pad(mm)}${ampm}`);
      out.add(`${twelve(hh)}:${pad(mm)}`);
      out.add(`${pad(hh)}:${pad(mm)}`);
      out.add(`${hh}:${pad(mm)}`);
    }
  const today = wallClock(o.now, o.tz);
  for (let k = 0; k <= o.rules.daysAhead; k++) {
    const day = addLocalDays(today, k);
    const weekday = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
    if (!o.rules.windows.some((w) => w.days.includes(weekday))) continue;
    out.add(DAY_NAMES[weekday]!);
    if (k === 0) out.add("today").add("tonight");
    if (k === 1) out.add("tomorrow");
    out.add(ordinal(day.d));
    out.add(MONTH_NAMES[day.m - 1]!);
  }
  return [...out].join(" ");
}

/** The hours' own bounds as people write them ("4pm 4:00pm 16:00 7pm 7:00pm 19:00"): LUME AI may tell a lead them. */
export function windowBoundWords(r: CallRules): string {
  const words = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number) as [number, number];
    const ampm = h < 12 ? "am" : "pm";
    return [m === 0 ? `${twelve(h)}${ampm}` : "", `${twelve(h)}:${pad(m)}${ampm}`, hhmm, `${h}:${pad(m)}`]
      .filter(Boolean)
      .join(" ");
  };
  return r.windows.flatMap((w) => [words(w.from), words(w.to)]).join(" ");
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th")}`;
const twelve = (hh: number) => (hh % 12 === 0 ? 12 : hh % 12);
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A call time as the time guard reads a message (lower case, "4pm" not "4 pm"): its day, "today" or "tomorrow", its
 * date and month, and its time each way people write one.
 */
export function callTimeWords(at: Date, tz: string, now: Date): string {
  const c = wallClock(at, tz);
  const ahead = daysBetween(wallClock(now, tz), c);
  const ampm = c.hh < 12 ? "am" : "pm";
  return [
    DAY_NAMES[c.weekday],
    ahead === 0 ? (c.hh >= 17 ? "today tonight" : "today") : ahead === 1 ? "tomorrow" : "",
    ordinal(c.d),
    MONTH_NAMES[c.m - 1],
    c.mm === 0 ? `${twelve(c.hh)}${ampm}` : "",
    `${twelve(c.hh)}:${pad(c.mm)}${ampm}`,
    // On a 12-hour clock without am or pm ("from 5:00 to 5:30 pm", eval 2026-11-04).
    `${twelve(c.hh)}:${pad(c.mm)}`,
    `${pad(c.hh)}:${pad(c.mm)}`,
    `${c.hh}:${pad(c.mm)}`,
  ]
    .filter(Boolean)
    .join(" ");
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** "November 3, Tuesday at 4 pm" (LUME's dates, month first). */
export function callTimeLabel(at: Date, tz: string): string {
  const c = wallClock(at, tz);
  const time = `${twelve(c.hh)}${c.mm ? `:${pad(c.mm)}` : ""} ${c.hh < 12 ? "am" : "pm"}`;
  return `${cap(MONTH_NAMES[c.m - 1]!)} ${c.d}, ${cap(DAY_NAMES[c.weekday]!)} at ${time}`;
}

/** A call time on the business's clock, as LUME AI reads and writes them ("YYYY-MM-DDTHH:mm"). */
export function callStamp(at: Date, tz: string): string {
  const c = wallClock(at, tz);
  return `${c.y}-${pad(c.m)}-${pad(c.d)}T${pad(c.hh)}:${pad(c.mm)}`;
}

/** Days as a run ("Monday to Friday") or a list ("Monday and Wednesday"), Monday first. */
function daysWords(days: number[]): string {
  const week = [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d));
  const at = (d: number) => [1, 2, 3, 4, 5, 6, 0].indexOf(d);
  const run = week.length > 2 && week.every((d, i) => i === 0 || at(d) === at(week[i - 1]!) + 1);
  const name = (d: number) => cap(DAY_NAMES[d]!);
  if (run) return `${name(week[0]!)} to ${name(week.at(-1)!)}`;
  if (week.length <= 2) return week.map(name).join(" and ");
  return `${week.slice(0, -1).map(name).join(", ")} and ${name(week.at(-1)!)}`;
}

/** The windows, for LUME AI's instructions: "Monday to Friday 16:00 to 19:00; Saturday 11:00 to 13:00". */
export function windowsWords(r: CallRules): string {
  return r.windows.map((w) => `${daysWords(w.days)} ${w.from} to ${w.to}`).join("; ");
}
