"use client";
import Link from "next/link";
import { dayKey, meetingState } from "@/lib/calendar/agenda";
import type { Meeting } from "@/lib/calendar/types";
import { nearDay, timeOf } from "@/lib/dates";
import m from "./meetings.module.css";

const MIN = 60_000;

/** "2:30 – 3 pm", "11:30 am – 12 pm": the meridiem said once when both ends share it. */
export function timeRange(start: Date, end: Date, tz: string): string {
  const a = timeOf(start, tz);
  const b = timeOf(end, tz);
  const [, sa] = a.split(" ");
  const [, sb] = b.split(" ");
  return sa === sb ? `${a.replace(/ (am|pm)$/, "")} – ${b}` : `${a} – ${b}`;
}

/**
 * The lead's next meeting (canvas LeadDrawer): a clean card with the blue-to-sky rule, a countdown ring when
 * it's close, "in 15 min" in amber, Join and Open in Calendar. Nothing to come: no card.
 */
export function NextMeeting({ meetings, tz, now }: { meetings: Meeting[]; tz: string; now: Date }) {
  const next = [...meetings]
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .find((x) => ["scheduled", "soon"].includes(meetingState(x, now)));
  if (!next) return null;
  const start = new Date(next.startsAt);
  const soon = meetingState(next, now) === "soon";
  const mins = Math.max(0, Math.ceil((start.getTime() - now.getTime()) / MIN));
  // The ring empties over the last hour before the call.
  const left = Math.min(1, mins / 60);
  return (
    <section className={m.next} aria-label="Next meeting" data-soon={soon || undefined}>
      {mins <= 60 && (
        <span className={m.ring} aria-hidden>
          <svg viewBox="0 0 44 44">
            <circle cx="22" cy="22" r="19" className={m.track} />
            <circle
              cx="22"
              cy="22"
              r="19"
              className={m.fill}
              style={{ strokeDashoffset: `${119.4 * (1 - left)}` }}
            />
          </svg>
          <b>{mins}</b>
        </span>
      )}
      <div className={m.nextBody}>
        <h3 className={m.kicker}>
          <span>Next meeting · {nearDay(start, tz, now).split(",")[0]}</span>
          {soon && (
            <span className={m.soon}>
              <i aria-hidden />
              {mins > 0 ? `in ${mins} min` : "now"}
            </span>
          )}
        </h3>
        <p className={m.nextTitle}>
          {next.title}, {timeRange(start, new Date(next.endsAt), tz)}
        </p>
        <p className={m.src}>
          {next.matchedBy === "calendly" ? (
            <>
              <img src="/brand/calendly.svg" alt="" width={14} height={14} />
              Booked through Calendly
            </>
          ) : (
            <>
              <span className={m.gtile}>
                <img src="/brand/google-calendar.png" alt="" width={11} height={11} />
              </span>
              From Google Calendar
            </>
          )}
        </p>
        <div className={m.actions}>
          {next.link && (
            <a className={m.join} href={next.link} target="_blank" rel="noopener noreferrer">
              Join
            </a>
          )}
          <Link className={m.quiet} href={`/calendar?d=${dayKey(start, tz)}&m=${next.id}`}>
            Open in Calendar
          </Link>
        </div>
      </div>
    </section>
  );
}
