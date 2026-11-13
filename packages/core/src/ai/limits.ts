import { wallTime } from "../tasks/time";

/**
 * LUME AI's limits (spec 2026-10-18 §2.2), Claude-style: reads in a rolling hour, and in a week that starts Monday
 * 00:00 on the business's clock; or, from a licence that signs it (Autopilot spec 2026-10-19 §4, owner: monthly and
 * generous), in a calendar month from the 1st at 00:00 on the business's clock, which replaces the week. Pure: the API
 * counts, this decides.
 */
const HOUR = 3_600_000;

/** `leadsN`: AI leads counted this month (owner's spec 2026-11-12). */
export type AiUsage = {
  hourN: number;
  hourOldest: Date | null;
  weekN: number;
  monthN?: number;
  leadsN?: number;
};
/** `monthly` is the actions a month (a hidden safety net once a licence counts AI leads); `leads` the AI leads. */
export type AiLimits = {
  hourly: number | null;
  weekly: number | null;
  monthly?: number | null;
  leads?: number | null;
};
export type AiLimit = { used: number; limit: number | null; resetsAt: string };
export type AiPause = { by: "hour" | "week" | "month"; until: string };
/**
 * `leads`: the month's AI leads. Using them all up isn't a pause: leads counted this month keep LUME AI, and only a new
 * lead can't start. `paused` is the hour, the week or the month's actions (the safety net).
 */
export type AiLimitState = {
  hour: AiLimit;
  week: AiLimit;
  month: AiLimit;
  leads: AiLimit;
  paused: AiPause | null;
};

/** The local calendar date of `at` on `tz`, and its weekday (Monday 1 … Sunday 7). */
function localDay(at: Date, tz: string): { y: number; m: number; d: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), dow };
}

export function aiWindows(
  now: Date,
  tz: string,
): { hourSince: Date; weekStart: Date; nextWeekStart: Date; monthStart: Date; nextMonthStart: Date } {
  const { y, m, d, dow } = localDay(now, tz);
  // wallTime normalises a day past the month's end, so "the 0th" or "the 33rd" is the right calendar day.
  const weekStart = wallTime(y, m, d - (dow - 1), 0, 0, tz);
  return {
    hourSince: new Date(now.getTime() - HOUR),
    weekStart,
    nextWeekStart: wallTime(y, m, d - (dow - 1) + 7, 0, 0, tz),
    monthStart: wallTime(y, m, 1, 0, 0, tz),
    // The 13th month is next January, as wallTime normalises it.
    nextMonthStart: wallTime(y, m + 1, 1, 0, 0, tz),
  };
}

/**
 * What's used against each limit, when each resets, and whether LUME AI is paused now — by the week first (it's
 * the longer wait), then the hour, which frees up when the oldest read in it is an hour old.
 */
export function aiLimitState(u: AiUsage, limits: AiLimits, now: Date, tz: string): AiLimitState {
  const w = aiWindows(now, tz);
  const hourResets = new Date((u.hourOldest?.getTime() ?? now.getTime()) + HOUR).toISOString();
  const hour: AiLimit = { used: u.hourN, limit: limits.hourly, resetsAt: hourResets };
  const week: AiLimit = { used: u.weekN, limit: limits.weekly, resetsAt: w.nextWeekStart.toISOString() };
  const month: AiLimit = {
    used: u.monthN ?? 0,
    limit: limits.monthly ?? null,
    resetsAt: w.nextMonthStart.toISOString(),
  };
  const leads: AiLimit = {
    used: u.leadsN ?? 0,
    limit: limits.leads ?? null,
    resetsAt: w.nextMonthStart.toISOString(),
  };
  const paused: AiPause | null =
    month.limit !== null && month.used >= month.limit
      ? { by: "month", until: month.resetsAt }
      : week.limit !== null && week.used >= week.limit
        ? { by: "week", until: week.resetsAt }
        : hour.limit !== null && hour.used >= hour.limit
          ? { by: "hour", until: hour.resetsAt }
          : null;
  return { hour, week, month, leads, paused };
}

/** "at 3:40 pm", "tomorrow at 12:10 am", or "Monday": when LUME AI is back, on the business's clock. */
export function backWords(p: AiPause, now: Date, tz: string): string {
  const until = new Date(p.until);
  if (p.by === "month")
    return `on ${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", day: "numeric" }).format(until)}`;
  if (p.by === "week")
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(until);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(until)
    .replace(/\s?([AP])M$/, (_, x: string) => ` ${x.toLowerCase()}m`);
  const a = localDay(now, tz);
  const b = localDay(until, tz);
  return a.y === b.y && a.m === b.m && a.d === b.d ? `at ${time}` : `tomorrow at ${time}`;
}

/** The month "YYYY-MM" on the business's clock: the key a top-up is added under. */
export function aiMonthKey(now: Date, tz: string): string {
  const { y, m } = localDay(now, tz);
  return `${y}-${String(m).padStart(2, "0")}`;
}

/**
 * About how many days the month's allowance lasts at the pace so far (Autopilot spec 2026-10-19 §4, the ring): what's
 * left over the average a day since the 1st. Null with no limit or nothing used yet.
 */
export function aiPace(
  month: { used: number; limit: number | null },
  now: Date,
  monthStart: Date,
): { daysLeft: number | null } {
  if (month.limit === null || month.used <= 0) return { daysLeft: null };
  const days = Math.max(1 / 24, (now.getTime() - monthStart.getTime()) / 86_400_000);
  const perDay = month.used / days;
  return { daysLeft: Math.max(0, Math.floor((month.limit - month.used) / perDay)) };
}
