"use client";
import { meetingState } from "@/lib/calendar/agenda";
import type { Meeting } from "@/lib/calendar/types";
import { shortDate } from "@/lib/dates";
import { timeRange } from "./NextMeeting";
import m from "./meetings.module.css";

const OUTCOME: Partial<Record<Meeting["status"], { label: string; tone: string }>> = {
  completed: { label: "Held", tone: "ok" },
  no_show: { label: "No-show", tone: "bad" },
  rescheduled: { label: "Rescheduled", tone: "mute" },
  cancelled: { label: "Cancelled", tone: "mute" },
};

/**
 * The drawer's Meetings tab (canvas LeadDrawer): coming up, then earlier ones newest first, each with how it
 * went (and its note); an ended one with no outcome offers Log outcome.
 */
export function MeetingsTab({
  meetings,
  tz,
  now,
  onLogOutcome,
  canLog = () => true,
}: {
  meetings: Meeting[];
  tz: string;
  now: Date;
  onLogOutcome: (meeting: Meeting) => void;
  /** Whether this person may record the meeting's outcome (theirs, or within their calendar.view scope). */
  canLog?: (meeting: Meeting) => boolean;
}) {
  if (!meetings.length) return <p className={m.none}>No meetings with this lead yet.</p>;
  const toCome = meetings
    .filter((x) => ["scheduled", "soon"].includes(meetingState(x, now)))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const earlier = meetings
    .filter((x) => !toCome.includes(x))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const row = (x: Meeting) => {
    const state = meetingState(x, now);
    const outcome = OUTCOME[x.status];
    const start = new Date(x.startsAt);
    return (
      <li key={x.id} data-id={x.id} className={m.row} data-state={state}>
        <i className={m.rule} aria-hidden />
        <span className={m.rowBody}>
          <b>{x.title}</b>
          <span>
            {shortDate(start, tz)}, {timeRange(start, new Date(x.endsAt), tz)}
          </span>
          {x.outcomeNote && <span className={m.noteText}>{x.outcomeNote}</span>}
        </span>
        {outcome && (
          <span className={m.pill} data-tone={outcome.tone}>
            {outcome.label}
          </span>
        )}
        {state === "needsOutcome" && canLog(x) && (
          <button type="button" className={m.outcome} onClick={() => onLogOutcome(x)}>
            Log outcome
          </button>
        )}
      </li>
    );
  };
  return (
    <div className={m.tab}>
      {toCome.length > 0 && (
        <>
          <h3 className={m.groupHead}>Coming up</h3>
          <ul className={m.list} aria-label="Coming up">
            {toCome.map(row)}
          </ul>
        </>
      )}
      {earlier.length > 0 && (
        <>
          <h3 className={m.groupHead}>Earlier</h3>
          <ul className={m.list} aria-label="Earlier">
            {earlier.map(row)}
          </ul>
        </>
      )}
    </div>
  );
}
