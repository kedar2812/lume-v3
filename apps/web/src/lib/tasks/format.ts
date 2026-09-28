import { scopeOf, wallTime, type Actor } from "@lume/core/shared";

const MIN = 60_000;
type Parts = { y: number; m: number; d: number; hh: number; mm: number; wd: string; mon: string };

function parts(at: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const mon = new Intl.DateTimeFormat("en-GB", { timeZone: tz, month: "short" }).format(at);
  return { y: +p.year!, m: +p.month!, d: +p.day!, hh: +p.hour!, mm: +p.minute!, wd: p.weekday!, mon };
}
/** Whole local days from one date to another (calendar days, not 24-hour spans). */
const dayNumber = (p: Parts) => Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000);
const clock = (p: Parts) => `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;

/**
 * A follow-up's time as a person reads it, in their own day: "In 45 min", "Today, 16:30", "Tomorrow, 10:00",
 * "Thu, 10:00", "Mon 5 Oct, 10:00"; and when it's past, "20 min overdue" or "Yesterday, 18:00 (overdue)".
 */
export function whenInWords(iso: string, now: Date, tz: string): string {
  const at = new Date(iso);
  const diff = at.getTime() - now.getTime();
  // Under an hour, in minutes; from "60 min" on, the clock reads better ("Today, 16:30").
  const mins = Math.round(Math.abs(diff) / MIN);
  if (diff >= 0 && mins < 60) return `In ${Math.max(1, mins)} min`;
  if (diff < 0 && mins < 60) return `${Math.max(1, mins)} min overdue`;
  const a = parts(at, tz);
  const days = dayNumber(a) - dayNumber(parts(now, tz));
  const day =
    days === 0
      ? "Today"
      : days === 1
        ? "Tomorrow"
        : days === -1
          ? "Yesterday"
          : days > 1 && days < 7
            ? a.wd
            : `${a.wd} ${a.d} ${a.mon}`;
  return `${day}, ${clock(a)}${diff < 0 ? " (overdue)" : ""}`;
}

/** A `datetime-local` value ("2026-09-29T10:00") read as the person's wall clock, as an instant. */
export function localInputToIso(value: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return wallTime(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, tz).toISOString();
}

/** The person's timezone: their own setting, else the browser's (LUME stores it; the browser always knows one). */
export const timezoneOf = (userTz: string | null | undefined): string =>
  userTz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * Whom this person may give a follow-up to (the API's rule, 3A final review Minor 9): with Manage others'
 * follow-ups at `all`, everyone active; at `team`, their teams' members; otherwise nobody (no "For" picker).
 */
export function assignable<P extends { id: string; active: boolean }>(actor: Actor, people: P[]): P[] {
  const scope = scopeOf(actor, "tasks.manage_others");
  if (scope === "all") return people.filter((p) => p.active);
  if (scope === "team")
    return people.filter((p) => p.active && (p.id === actor.userId || actor.teamMemberIds.includes(p.id)));
  return [];
}
