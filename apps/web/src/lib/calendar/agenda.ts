import { scopeOf, wallTime, type Actor } from "@lume/core/shared";
import { addDays, dayKey, daysBetween, longDate, nearDay } from "@/lib/dates";
import type { Meeting } from "./types";

const MIN = 60_000;
/** A meeting is "starting soon" from this long before it starts until it ends (System board). */
export const SOON_MS = 15 * MIN;
/** The week grid's hours on the business's clock: 8 am to 8 pm. */
export const WEEK_FROM_HOUR = 8;
export const WEEK_TO_HOUR = 20;
/** The shortest block the week draws, so a short meeting stays readable. */
const MIN_BLOCK = 30;

/** The instant a day begins on the business's clock (a day key is YYYY-MM-DD). */
export function dayStart(key: string, tz: string): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return wallTime(y, m, d, 0, 0, tz);
}

export type MeetingState = "scheduled" | "soon" | "needsOutcome" | "over" | "cancelled";

/** Where a meeting is in its life (the System board's "A meeting's states"). */
export function meetingState(m: Meeting, now: Date): MeetingState {
  if (m.status === "cancelled") return "cancelled";
  if (m.status !== "scheduled") return "over";
  const t = now.getTime();
  if (t >= new Date(m.endsAt).getTime()) return "needsOutcome";
  if (t >= new Date(m.startsAt).getTime() - SOON_MS) return "soon";
  return "scheduled";
}

export type AgendaDay = { key: string; label: string; meetings: Meeting[] };

const byStart = (a: Meeting, b: Meeting) => a.startsAt.localeCompare(b.startsAt);

/**
 * The agenda: from the chosen day on, up to `max` days that have meetings, each headed "Today · October 1,
 * Thursday" (near days in words, then the date) or by its date alone.
 */
export function agendaDays(
  meetings: Meeting[],
  fromKey: string,
  tz: string,
  now: Date,
  max = 3,
): AgendaDay[] {
  const days = new Map<string, Meeting[]>();
  for (const m of [...meetings].sort(byStart)) {
    const key = dayKey(new Date(m.startsAt), tz);
    if (key < fromKey) continue;
    days.set(key, [...(days.get(key) ?? []), m]);
  }
  return [...days.keys()]
    .sort()
    .slice(0, max)
    .map((key) => {
      const when = dayStart(key, tz);
      const near = nearDay(when, tz, now);
      const date = longDate(when, tz);
      return { key, label: near === date ? date : `${near} · ${date}`, meetings: days.get(key)! };
    });
}

/** Mine keeps the person's own meetings; a stage keeps meetings whose lead is in it. */
export function filterMeetings(
  meetings: Meeting[],
  f: { mineOf: string | null; stageId: string | null },
): Meeting[] {
  return meetings.filter(
    (m) => (!f.mineOf || m.ownerId === f.mineOf) && (!f.stageId || m.lead?.stageId === f.stageId),
  );
}

/** Everyone or Mine is offered only when the person sees beyond their own meetings. */
export function showsEveryone(actor: Actor): boolean {
  const s = scopeOf(actor, "calendar.view");
  return s === "team" || s === "all";
}

export type WeekBlock = {
  meeting: Meeting;
  /** The column, 0–6, in the week's own order. */
  day: number;
  /** Minutes from the grid's start (8 am) to the block's top, and its height in minutes. */
  top: number;
  height: number;
  /** A meeting outside 8 am–8 pm is pinned to the grid's edge, its real time still written on it. */
  clipped: "before" | "after" | null;
};

/** Each meeting of the week on its day (on the business's clock) and its hour. */
export function weekBlocks(meetings: Meeting[], week: string[], tz: string): WeekBlock[] {
  const span = (WEEK_TO_HOUR - WEEK_FROM_HOUR) * 60;
  const out: WeekBlock[] = [];
  for (const m of [...meetings].sort(byStart)) {
    const start = new Date(m.startsAt);
    const day = week.indexOf(dayKey(start, tz));
    if (day < 0) continue;
    const gridStart = dayStart(week[day]!, tz).getTime() + WEEK_FROM_HOUR * 60 * MIN;
    const from = (start.getTime() - gridStart) / MIN;
    const length = Math.max(MIN_BLOCK, (new Date(m.endsAt).getTime() - start.getTime()) / MIN);
    const height = Math.min(length, span);
    if (from + MIN_BLOCK <= 0) out.push({ meeting: m, day, top: 0, height: MIN_BLOCK, clipped: "before" });
    else if (from >= span)
      out.push({ meeting: m, day, top: span - MIN_BLOCK, height: MIN_BLOCK, clipped: "after" });
    else
      out.push({
        meeting: m,
        day,
        top: Math.max(0, from),
        height: Math.min(height, span - Math.max(0, from)),
        clipped: null,
      });
  }
  return out;
}

export type CalendarUrl = { view: "agenda" | "week"; day: string | null; meeting: string | null };

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** `?view=week&d=2026-10-01&m=<id>`: a link reopens the same view, day and meeting. */
export function readCalendarUrl(q: URLSearchParams): CalendarUrl {
  const d = q.get("d");
  return {
    view: q.get("view") === "week" ? "week" : "agenda",
    day: d && DAY_KEY.test(d) && !Number.isNaN(Date.parse(d)) ? d : null,
    meeting: q.get("m") || null,
  };
}

export function writeCalendarUrl(s: CalendarUrl): string {
  const q = new URLSearchParams();
  if (s.view === "week") q.set("view", "week");
  if (s.day) q.set("d", s.day);
  if (s.meeting) q.set("m", s.meeting);
  const str = q.toString();
  return str ? `?${str}` : "";
}

/** Today's key, and the day key `n` days on: re-exported so the screen reads one module. */
export { addDays, dayKey, daysBetween };
