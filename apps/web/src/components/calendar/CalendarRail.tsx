"use client";
import { useMemo, useState } from "react";
import { addDays, dayKey, dayStart, meetingState } from "@/lib/calendar/agenda";
import type { Meeting } from "@/lib/calendar/types";
import { timeOf, weekOf } from "@/lib/dates";
import s from "./calendar.module.css";

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

/** The weeks the month holding `key` covers (four to six), each day a key: no week wholly of the next month. */
export function monthGrid(monthKey: string, weekStart: "monday" | "sunday"): string[] {
  const first = `${monthKey.slice(0, 7)}-01`;
  const start = weekOf(first, weekStart)[0]!;
  const [y, m] = first.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(last) - Date.parse(start)) / 86_400_000) + 1;
  return Array.from({ length: Math.ceil(days / 7) * 7 }, (_, i) => addDays(start, i));
}

/**
 * The rail (canvas Main): a mini month that jumps the agenda (dots on days with meetings), this week's
 * held, no-show and to come, the meetings that need their outcome, and where LUME reads from.
 */
export function CalendarRail({
  meetings,
  day,
  today,
  week,
  tz,
  now,
  weekStart,
  sources,
  onPick,
  onLogOutcome,
}: {
  meetings: Meeting[];
  day: string;
  today: string;
  week: string[];
  tz: string;
  now: Date;
  weekStart: "monday" | "sunday";
  sources?: { google: { updated: string | null; healthy: boolean } | null; calendly: boolean };
  onPick: (key: string) => void;
  onLogOutcome?: (m: Meeting) => void;
}) {
  const [month, setMonth] = useState(day.slice(0, 7));
  const [shownFor, setShownFor] = useState(day);
  // The chosen day moved into another month (T, arrows, a link): the mini month follows it.
  if (shownFor !== day) {
    setShownFor(day);
    setMonth(day.slice(0, 7));
  }
  const busy = useMemo(() => new Set(meetings.map((m) => dayKey(new Date(m.startsAt), tz))), [meetings, tz]);
  const grid = monthGrid(`${month}-01`, weekStart);
  const [y, mo] = month.split("-").map(Number) as [number, number];
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, mo - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
  };
  const weekdays =
    weekStart === "monday" ? ["M", "T", "W", "T", "F", "S", "S"] : ["S", "M", "T", "W", "T", "F", "S"];

  const inWeek = meetings.filter((m) => week.includes(dayKey(new Date(m.startsAt), tz)));
  const held = inWeek.filter((m) => m.status === "completed").length;
  const noShow = inWeek.filter((m) => m.status === "no_show").length;
  const toCome = inWeek.filter((m) => ["scheduled", "soon"].includes(meetingState(m, now))).length;
  const need = meetings.filter((m) => meetingState(m, now) === "needsOutcome");
  const first = need[0];

  return (
    <aside className={s.rail} aria-label="This month and this week">
      <div className={s.mini}>
        <div className={s.miniHead}>
          <h2>
            {MONTHS[mo - 1]} {y}
          </h2>
          <button type="button" className={s.ibtn} aria-label="Previous month" onClick={() => shift(-1)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <button type="button" className={s.ibtn} aria-label="Next month" onClick={() => shift(1)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>
        <div className={s.miniGrid} role="group" aria-label={`${MONTHS[mo - 1]} ${y}`}>
          {weekdays.map((w, i) => (
            <span key={i} className={s.wd} aria-hidden>
              {w}
            </span>
          ))}
          {grid.map((k) => (
            <button
              key={k}
              type="button"
              className={s.md}
              data-out={!k.startsWith(month) || undefined}
              data-today={k === today || undefined}
              data-picked={(k === day && k !== today) || undefined}
              aria-current={k === day ? "date" : undefined}
              aria-label={`${k === today ? "Today, " : ""}${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", day: "numeric", weekday: "long" }).format(dayStart(k, tz))}${busy.has(k) ? ", has meetings" : ""}`}
              onClick={() => onPick(k)}
            >
              {Number(k.slice(8))}
              {busy.has(k) && <i className={s.pip} aria-hidden />}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className={s.cap}>This week</h3>
        <div className={s.stat}>
          <div data-tone="ok">
            <b>{held}</b>held
          </div>
          <div data-tone="bad">
            <b>{noShow}</b>no-show
          </div>
          <div data-tone="acc">
            <b>{toCome}</b>to come
          </div>
        </div>
      </div>

      {first && (
        <div className={s.need}>
          <h3>
            {need.length} {need.length === 1 ? "meeting needs its outcome" : "meetings need their outcome"}
          </h3>
          <p>
            {first.lead?.name ?? first.title} · {first.title}, {timeOf(new Date(first.startsAt), tz)}
          </p>
          {onLogOutcome && (
            <button type="button" className={s.btn} onClick={() => onLogOutcome(first)}>
              Log outcome
            </button>
          )}
        </div>
      )}

      {sources && (sources.google || sources.calendly) && (
        <div className={s.conn}>
          <h3 className={s.cap}>Reading from</h3>
          {sources.google && (
            <div className={s.connrow}>
              <span className={s.gtile}>
                <img src="/brand/google-calendar.png" alt="" width={14} height={14} />
              </span>
              <span>
                Google Calendar
                <small>{sources.google.updated ? `updated ${sources.google.updated}` : "not read yet"}</small>
              </span>
              <i
                data-ok={sources.google.healthy || undefined}
                aria-label={sources.google.healthy ? "Working" : "Needs you"}
              />
            </div>
          )}
          {sources.calendly && (
            <div className={s.connrow}>
              <img src="/brand/calendly.svg" alt="" width={20} height={20} />
              <span>
                Calendly
                <small>bookings arrive in seconds</small>
              </span>
              <i data-ok aria-label="Working" />
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
