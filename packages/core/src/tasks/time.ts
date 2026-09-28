/**
 * Follow-up times in the person's own day (Phase 3 spec §3 "Times"). Entered and shown in their timezone,
 * stored as instants. Only `Intl` is used: no timezone database ships with LUME.
 */

export type DuePreset = "in_1h" | "in_3h" | "tomorrow_10" | "in_2d" | "next_monday";
export type SnoozePreset = "15m" | "1h" | "evening" | "tomorrow_morning";
export type Recurrence = {
  every: number;
  unit: "day" | "week";
  /** The last local day a repeat may fall on (YYYY-MM-DD), or null for no end. */
  until: string | null;
  stopOn: ("won" | "lost" | "reply_logged")[];
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const MAX_OFFSET = 43_200; // 30 days, in minutes
const MAX_REMINDERS = 5;

type Local = { y: number; m: number; d: number; hh: number; mm: number };
const formats = new Map<string, Intl.DateTimeFormat>();
const format = (tz: string) => {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(tz, f);
  }
  return f;
};
/** The wall clock in `tz` at an instant. */
function local(at: Date, tz: string): Local & { ss: number } {
  const p = Object.fromEntries(
    format(tz)
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { y: +p.year!, m: +p.month!, d: +p.day!, hh: +p.hour!, mm: +p.minute!, ss: +p.second! };
}
/** How far `tz` is ahead of UTC at an instant, in ms. */
function offsetAt(ms: number, tz: string): number {
  const l = local(new Date(ms), tz);
  return Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm, l.ss) - Math.floor(ms / 1000) * 1000;
}
const sameWall = (ms: number, want: number, tz: string) => ms + offsetAt(ms, tz) === want;

/**
 * The instant a local wall time happens. A time that never happens (the spring gap) moves forward to the
 * first minute that does; one that happens twice (the autumn overlap) takes the earlier.
 */
export function wallTime(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const want = Date.UTC(y, m - 1, d, hh, mm);
  const before = offsetAt(want - 12 * HOUR, tz);
  const after = offsetAt(want + 12 * HOUR, tz);
  const valid = [want - before, want - after].filter((t) => sameWall(t, want, tz));
  if (valid.length) return new Date(Math.min(...valid));
  // In the gap: the transition itself is the first valid minute. Search between the two readings.
  let lo = want - after;
  let hi = want - before;
  while (hi - lo > MIN) {
    const mid = lo + Math.floor((hi - lo) / 2 / MIN) * MIN;
    if (offsetAt(mid, tz) === after) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/** A local calendar date moved by whole days. */
function addDays(l: Pick<Local, "y" | "m" | "d">, days: number) {
  const t = new Date(Date.UTC(l.y, l.m - 1, l.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const at = (l: Pick<Local, "y" | "m" | "d">, hh: number, mm: number, tz: string) =>
  wallTime(l.y, l.m, l.d, hh, mm, tz);
const weekday = (l: Pick<Local, "y" | "m" | "d">) => new Date(Date.UTC(l.y, l.m - 1, l.d)).getUTCDay();

export function dueFromPreset(p: DuePreset, now: Date, tz: string): Date {
  const today = local(now, tz);
  switch (p) {
    case "in_1h":
      return new Date(now.getTime() + HOUR);
    case "in_3h":
      return new Date(now.getTime() + 3 * HOUR);
    case "in_2d":
      return new Date(now.getTime() + 48 * HOUR);
    case "tomorrow_10":
      return at(addDays(today, 1), 10, 0, tz);
    case "next_monday":
      return at(addDays(today, (8 - weekday(today)) % 7 || 7), 10, 0, tz);
  }
}

/** A due-time choice an admin can edit (3C; report §10.2). `at.days`: 0 today, 1 tomorrow. */
export type DuePresetDef = {
  id: string;
  label: string;
  rule:
    | { in: { n: number; unit: "minute" | "hour" | "day" } }
    | { at: { days: number; time: string } }
    | { weekday: { day: number; time: string } };
};

/** 3A's five choices, with their ids, so anything that sends one keeps working. */
export const DEFAULT_DUE_PRESETS: DuePresetDef[] = [
  { id: "in_1h", label: "In 1 hour", rule: { in: { n: 1, unit: "hour" } } },
  { id: "in_3h", label: "In 3 hours", rule: { in: { n: 3, unit: "hour" } } },
  { id: "tomorrow_10", label: "Tomorrow 10:00", rule: { at: { days: 1, time: "10:00" } } },
  { id: "in_2d", label: "In 2 days", rule: { in: { n: 2, unit: "day" } } },
  { id: "next_monday", label: "Next Monday", rule: { weekday: { day: 1, time: "10:00" } } },
];

const hhmm = (t: string) => t.split(":").map(Number) as [number, number];
const UNIT_MS = { minute: MIN, hour: HOUR, day: 24 * HOUR } as const;

export function dueFromPresetDef(def: DuePresetDef, now: Date, tz: string): Date {
  const r = def.rule;
  if ("in" in r) return new Date(now.getTime() + r.in.n * UNIT_MS[r.in.unit]);
  const today = local(now, tz);
  if ("at" in r) {
    const [hh, mm] = hhmm(r.at.time);
    const due = at(addDays(today, r.at.days), hh, mm, tz);
    // "Today at 17:00" asked for at 18:00 means tomorrow at 17:00, never a time already gone.
    return due.getTime() > now.getTime() ? due : at(addDays(today, r.at.days + 1), hh, mm, tz);
  }
  const [hh, mm] = hhmm(r.weekday.time);
  return at(addDays(today, (r.weekday.day - weekday(today) + 7) % 7 || 7), hh, mm, tz);
}

/** The business's working week (0 = Sunday), in its own timezone. */
export type WorkingHours = { days: number[]; start: string; end: string };

/**
 * A time LUME picked itself, moved into working hours (report §10.2): unchanged inside them, else the
 * start of the next working day (today's, when it's still before the start).
 */
export function shiftToWorkingHours(when: Date, wh: WorkingHours, tz: string): Date {
  const l = local(when, tz);
  const [sh, sm] = hhmm(wh.start);
  const [eh, em] = hhmm(wh.end);
  const now = l.hh * 60 + l.mm;
  for (let k = 0; k < 8; k++) {
    const day = addDays(l, k);
    if (!wh.days.includes(weekday(day))) continue;
    if (k > 0 || now < sh * 60 + sm) return at(day, sh, sm, tz);
    if (now < eh * 60 + em) return when;
  }
  return when; // no working days: nothing to shift into
}

export function snoozeUntil(p: SnoozePreset, now: Date, tz: string): Date {
  const today = local(now, tz);
  switch (p) {
    case "15m":
      return new Date(now.getTime() + 15 * MIN);
    case "1h":
      return new Date(now.getTime() + HOUR);
    case "evening": {
      const late = today.hh * 60 + today.mm >= 17 * 60 + 30;
      return at(late ? addDays(today, 1) : today, 18, 0, tz);
    }
    case "tomorrow_morning":
      return at(addDays(today, 1), 9, 0, tz);
  }
}

/** When each reminder fires, earliest first. Offsets are whole minutes before the due time (0 = at it). */
export function reminderTimes(due: Date, minutes: number[]): { offset: number; at: Date }[] {
  for (const o of minutes)
    if (!Number.isInteger(o) || o < 0 || o > MAX_OFFSET)
      throw new RangeError(`A reminder offset must be whole minutes from 0 to ${MAX_OFFSET}.`);
  const offsets = [...new Set(minutes)].sort((a, b) => b - a);
  if (offsets.length > MAX_REMINDERS) throw new RangeError("A follow-up takes at most five reminders.");
  return offsets.map((offset) => ({ offset, at: new Date(due.getTime() - offset * MIN) }));
}

/**
 * The next follow-up of a repeating one: `every` days or weeks later at the same local time, stepped on
 * past `now` (a series done late doesn't land in the past), or null after its last day.
 */
export function nextOccurrence(due: Date, r: Recurrence, now: Date, tz: string): Date | null {
  const start = local(due, tz);
  const step = r.every * (r.unit === "week" ? 7 : 1);
  if (!Number.isInteger(step) || step < 1) return null;
  const behind = Math.max(0, Math.floor((now.getTime() - due.getTime()) / (step * 24 * HOUR)));
  for (let k = Math.max(1, behind); k < behind + 3; k++) {
    const day = addDays(start, step * k);
    const next = at(day, start.hh, start.mm, tz);
    if (next.getTime() <= now.getTime()) continue;
    const iso = `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
    return r.until && iso > r.until ? null : next;
  }
  return null;
}

/** The person's own midnight to midnight around `now`. */
export function localDayBounds(now: Date, tz: string): { start: Date; end: Date } {
  const today = local(now, tz);
  return { start: at(today, 0, 0, tz), end: at(addDays(today, 1), 0, 0, tz) };
}
