"use client";
import Link from "next/link";
import { dayKey, meetingState } from "@/lib/calendar/agenda";
import type { Meeting } from "@/lib/calendar/types";
import { timeOf } from "@/lib/dates";
import type { TodayMeeting } from "@/lib/tasks/types";
import s from "./calls.module.css";

const MIN = 60_000;
/** A Today call as the calendar's states read it (the same rules as the Calendar page). */
const asMeeting = (m: TodayMeeting): Meeting => ({
  ...m,
  location: null,
  ownerId: "",
  outcomeNote: null,
  lead: m.lead ? { ...m.lead, pipelineId: "", stageId: "" } : null,
});
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const minutes = (m: TodayMeeting) =>
  Math.round((new Date(m.endsAt).getTime() - new Date(m.startsAt).getTime()) / MIN);

/**
 * The brief line's calls (canvas Today): the next one to come — "Your call with Dana is in 15 minutes", or
 * at its time when further off — then how many from earlier still need their outcome. Null: nothing to say.
 */
export function callsBrief(meetings: TodayMeeting[], now: Date, tz: string): string | null {
  const next = meetings.find((m) => ["scheduled", "soon"].includes(meetingState(asMeeting(m), now)));
  const owed = meetings.filter((m) => meetingState(asMeeting(m), now) === "needsOutcome").length;
  const parts: string[] = [];
  if (next) {
    // About the person, so a real event title ("Dana Whitfield and Kedar") is never bent into the sentence.
    const who = next.lead ? `Your call with ${first(next.lead.name)}` : next.title;
    const mins = Math.round((new Date(next.startsAt).getTime() - now.getTime()) / MIN);
    parts.push(
      mins <= 0
        ? `${who} is starting now.`
        : mins <= 60
          ? `${who} is in ${mins} minute${mins === 1 ? "" : "s"}.`
          : `${who} is at ${timeOf(new Date(next.startsAt), tz)}.`,
    );
  }
  if (owed)
    parts.push(
      owed === 1
        ? "One call from earlier still needs its outcome."
        : `${owed} calls from earlier still need their outcome.`,
    );
  return parts.length ? parts.join(" ") : null;
}

const OUTCOME: Record<string, string> = { completed: "Held", no_show: "No-show", rescheduled: "Rescheduled" };

/**
 * Today's calls (canvas Today): between the hero and Up next, only on a day with calls. Each has its time
 * and length, the rule (blue to sky; amber when it's about to start; grey once over), the person and title,
 * where it came from, and its WhatsApp reminder. Held, Log outcome (amber), or "in 15 min" with Join.
 */
export function TodayCalls({
  meetings,
  tz,
  now,
  onLogOutcome,
}: {
  meetings: TodayMeeting[];
  tz: string;
  now: Date;
  onLogOutcome?: (m: TodayMeeting) => void;
}) {
  if (!meetings.length) return null;
  const today = dayKey(now, tz);
  const states = meetings.map((m) => meetingState(asMeeting(m), now));
  const toCome = states.filter((x) => x === "scheduled" || x === "soon").length;
  return (
    <section className={s.card} aria-labelledby="today-calls">
      <header className={s.head}>
        <h2 id="today-calls">Today&apos;s calls</h2>
        <span className={s.count}>
          {meetings.length} · {toCome} to come
        </span>
        <Link href="/calendar" className={s.toCalendar}>
          Calendar ›
        </Link>
      </header>
      <ul className={s.list}>
        {meetings.map((m, i) => {
          const state = states[i]!;
          const start = new Date(m.startsAt);
          const person = m.lead?.name ?? m.title;
          const mins = Math.max(0, Math.ceil((start.getTime() - now.getTime()) / MIN));
          return (
            <li
              key={m.id}
              role="group"
              aria-label={`${person}, ${m.title}, ${timeOf(start, tz)}`}
              className={s.row}
              data-state={state}
              data-day={dayKey(start, tz) === today || undefined}
            >
              <span className={s.time}>
                <b>{timeOf(start, tz)}</b>
                <span>{minutes(m)} min</span>
              </span>
              <i className={s.rule} aria-hidden />
              <span className={s.body}>
                <span className={s.who}>
                  {person}
                  {state === "soon" && (
                    <span className={s.soon}>
                      <i aria-hidden />
                      {mins > 0 ? `in ${mins} min` : "now"}
                    </span>
                  )}
                </span>
                <span className={s.meta}>
                  {m.lead ? m.title : "Not with a lead yet"}
                  <span aria-hidden>·</span>
                  {m.matchedBy === "calendly" ? (
                    <span className={s.src}>
                      <img src="/brand/calendly.svg" alt="" width={14} height={14} />
                      Booked through Calendly
                    </span>
                  ) : (
                    <span className={s.src}>
                      <span className={s.gtile}>
                        <img src="/brand/google-calendar.png" alt="" width={11} height={11} />
                      </span>
                      Google Calendar
                    </span>
                  )}
                  {m.reminder && (
                    <>
                      <span aria-hidden>·</span>
                      <span className={s.src}>
                        <img src="/brand/whatsapp.svg" alt="" width={12} height={12} />
                        {m.reminder.sent
                          ? `reminder sent ${timeOf(new Date(m.reminder.at), tz)}`
                          : `reminder at ${timeOf(new Date(m.reminder.at), tz)}`}
                      </span>
                    </>
                  )}
                </span>
              </span>
              <span className={s.end}>
                {OUTCOME[m.status] && (
                  <span
                    className={s.pill}
                    data-tone={m.status === "completed" ? "ok" : m.status === "no_show" ? "bad" : "mute"}
                  >
                    {m.status === "completed" && (
                      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
                        <path
                          d="M3.5 8.5 6.5 11.5 12.5 4.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                    )}
                    {OUTCOME[m.status]}
                  </span>
                )}
                {state === "needsOutcome" && onLogOutcome && (
                  <button type="button" className={s.outcome} onClick={() => onLogOutcome(m)}>
                    Log outcome
                  </button>
                )}
                {state === "needsOutcome" && !onLogOutcome && (
                  <Link href={`/calendar?m=${m.id}`} className={s.outcome}>
                    Log outcome
                  </Link>
                )}
                {m.lead && (
                  <Link href={`/leads?lead=${m.lead.id}`} className={s.quiet}>
                    Open lead
                  </Link>
                )}
                {m.link && (state === "soon" || state === "scheduled") && (
                  <a
                    className={state === "soon" ? s.join : s.quiet}
                    href={m.link}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Join
                  </a>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
