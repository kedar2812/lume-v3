"use client";
import { Avatar } from "@/components/ui/Avatar";
import { meetingState, type AgendaDay } from "@/lib/calendar/agenda";
import type { Meeting } from "@/lib/calendar/types";
import { timeOf } from "@/lib/dates";
import { tokenColor } from "@/lib/leads/colors";
import s from "./calendar.module.css";

const OUTCOME: Record<string, { label: string; tone: "ok" | "bad" | "mute" }> = {
  completed: { label: "Held", tone: "ok" },
  no_show: { label: "No-show", tone: "bad" },
  rescheduled: { label: "Rescheduled", tone: "mute" },
  cancelled: { label: "Cancelled", tone: "mute" },
};

/** "in 14 min", "now": the starting-soon words (System board: amber, a live dot). */
export function soonWords(m: Meeting, now: Date): string {
  const mins = Math.ceil((new Date(m.startsAt).getTime() - now.getTime()) / 60_000);
  return mins > 0 ? `in ${mins} min` : "now";
}

/** The mark of where a meeting came from: Calendly's own, else Google Calendar's (on white). */
export function SourceMark({ m }: { m: Meeting }) {
  return m.matchedBy === "calendly" ? (
    <img className={s.mark} src="/brand/calendly.svg" alt="From Calendly" width={16} height={16} />
  ) : (
    <span className={s.gtile}>
      <img src="/brand/google-calendar.png" alt="From Google Calendar" width={12} height={12} />
    </span>
  );
}

/**
 * The agenda (canvas Main): each day under its date rule, each meeting with its time, the 3px rule (blue to
 * sky; amber when starting soon; grey when past; dashed when cancelled), the lead and stage, where it came
 * from and whose it is. Join is the main action only for the meeting about to start.
 */
export function Agenda({
  days,
  tz,
  now,
  people,
  stages,
  openId,
  washed,
  onOpen,
  onLogOutcome,
  onToday,
}: {
  days: AgendaDay[];
  tz: string;
  now: Date;
  people: { id: string; name: string }[];
  stages: { id: string; name: string; color: string }[];
  openId: string | null;
  /** Rows a Refresh brought or changed, washed blue once. */
  washed?: Set<string>;
  onOpen: (id: string) => void;
  onLogOutcome?: (m: Meeting) => void;
  /** Shown on the empty agenda when the chosen day isn't today. */
  onToday?: () => void;
}) {
  if (days.length === 0)
    return (
      <div className={s.empty}>
        <h2>Nothing booked from here on</h2>
        <p>Meetings with leads show up as soon as they&apos;re on a calendar.</p>
        {onToday && (
          <button type="button" className={s.btn} onClick={onToday}>
            Back to today
          </button>
        )}
      </div>
    );
  return (
    <div className={s.agenda}>
      {days.map((d) => (
        <section key={d.key} aria-label={d.label} className={s.day}>
          <h2 className={s.dayhead} data-today={d.label.startsWith("Today") || undefined}>
            {d.label}
            <span>
              {d.meetings.length} {d.meetings.length === 1 ? "meeting" : "meetings"}
            </span>
          </h2>
          {d.meetings.map((m) => {
            const state = meetingState(m, now);
            const stage = m.lead ? stages.find((x) => x.id === m.lead!.stageId) : undefined;
            const owner = people.find((p) => p.id === m.ownerId)?.name ?? "Someone";
            const outcome = OUTCOME[m.status];
            return (
              <div
                key={m.id}
                role="group"
                aria-label={`${m.title}, ${timeOf(new Date(m.startsAt), tz)}`}
                className={s.mrow}
                data-state={state}
                data-open={m.id === openId || undefined}
                data-washed={washed?.has(m.id) || undefined}
              >
                <button
                  type="button"
                  className={s.mhit}
                  aria-label={`${m.title}, ${timeOf(new Date(m.startsAt), tz)}, ${m.lead?.name ?? "not with a lead yet"}`}
                  onClick={() => onOpen(m.id)}
                >
                  <span className={s.mtime}>
                    <b>{timeOf(new Date(m.startsAt), tz)}</b>
                    <span>{timeOf(new Date(m.endsAt), tz)}</span>
                  </span>
                  <i className={s.mbar} aria-hidden />
                  <span className={s.mbody}>
                    <span className={s.mtitle}>{m.title}</span>
                    <span className={s.mmeta}>
                      <span className={s.lead}>{m.lead?.name ?? "Not with a lead yet"}</span>
                      {stage && (
                        <span className={s.stage}>
                          <i className={s.dot} style={{ background: tokenColor(stage.color) }} />
                          {stage.name}
                        </span>
                      )}
                      <SourceMark m={m} />
                      <Avatar name={owner} size={20} />
                    </span>
                  </span>
                </button>
                <span className={s.mend}>
                  {state === "soon" && (
                    <span className={s.soon}>
                      <i aria-hidden />
                      {soonWords(m, now)}
                    </span>
                  )}
                  {state === "needsOutcome" && onLogOutcome ? (
                    <button type="button" className={s.outcomeBtn} onClick={() => onLogOutcome(m)}>
                      Log outcome
                    </button>
                  ) : state === "needsOutcome" ? (
                    <button type="button" className={s.outcomeBtn} onClick={() => onOpen(m.id)}>
                      Log outcome
                    </button>
                  ) : null}
                  {outcome && (
                    <span className={s.pill} data-tone={outcome.tone}>
                      {outcome.label}
                    </span>
                  )}
                  {m.link && (state === "soon" || state === "scheduled") && (
                    <a
                      className={state === "soon" ? s.join : s.joinQuiet}
                      href={m.link}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <rect x="3" y="6" width="13" height="12" rx="2" />
                        <path d="M16 10l5-3v10l-5-3" />
                      </svg>
                      Join
                    </a>
                  )}
                </span>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
