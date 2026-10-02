"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { timeRange } from "@/components/leads/drawer/NextMeeting";
import { agendaDays, dayKey, meetingState } from "@/lib/calendar/agenda";
import type { Meeting } from "@/lib/calendar/types";
import { longDate, nearDay, timeOf } from "@/lib/dates";
import { releaseVelocity, rubberband, sheetDismisses } from "@/lib/motion";
import s from "./phone.module.css";

const MIN = 60_000;
const OUTCOME: Partial<Record<Meeting["status"], string>> = {
  completed: "Held",
  no_show: "No-show",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
};
const live = (m: Meeting, now: Date) => ["scheduled", "soon"].includes(meetingState(m, now));
const who = (m: Meeting) => m.lead?.name ?? m.title;

/**
 * The Calendar on a phone (Phase 5 canvas, Phone): the next call as a white hero card, then the days that have
 * meetings (Today, Tomorrow…) as one list. A tap opens the meeting in a bottom sheet.
 */
export function PhoneCalendar({
  meetings,
  tz,
  now,
  me,
  people,
  openId,
  onOpen,
  onLogOutcome,
  actions,
  notice,
}: {
  meetings: Meeting[];
  tz: string;
  now: Date;
  me: string;
  people: { id: string; name: string }[];
  openId: string | null;
  onOpen: (id: string | null) => void;
  onLogOutcome: (m: Meeting) => void;
  /** Refresh and the gear, beside the title. */
  actions?: ReactNode;
  /** About connecting Google Calendar, under the title. */
  notice?: ReactNode;
}) {
  const days = agendaDays(meetings, dayKey(now, tz), tz, now);
  const next = [...meetings].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).find((m) => live(m, now));
  const opened = openId ? (meetings.find((m) => m.id === openId) ?? null) : null;

  const tag = (m: Meeting) => {
    if (OUTCOME[m.status]) return OUTCOME[m.status];
    if (meetingState(m, now) === "needsOutcome") return "Log outcome";
    if (m.matchedBy === "calendly") return "Calendly";
    if (m.ownerId !== me) return people.find((p) => p.id === m.ownerId)?.name.split(" ")[0];
    return undefined;
  };

  return (
    <div className={s.phone}>
      <header className={s.head}>
        <div>
          <p className={s.date}>{longDate(now, tz)}</p>
          <h1 className={s.title}>Calendar</h1>
          <p className={s.privacy}>
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.45"
              aria-hidden
            >
              <rect x="3" y="7" width="10" height="7" rx="1.8" />
              <path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" />
            </svg>
            Meetings with leads only
          </p>
        </div>
        {actions && <div className={s.actions}>{actions}</div>}
      </header>
      {notice && <div className={s.notice}>{notice}</div>}

      {next && <Hero meeting={next} tz={tz} now={now} onOpen={onOpen} />}

      {days.length === 0 ? (
        <p className={s.none}>No meetings coming up.</p>
      ) : (
        days.map((d) => {
          const name = d.label.split(" · ")[0]!;
          return (
            <section key={d.key} className={s.group} aria-label={name}>
              <div className={s.groupHead}>
                <h2>{name}</h2>
                <span>
                  {d.meetings.length} meeting{d.meetings.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className={s.list}>
                {d.meetings.map((m) => {
                  const t = tag(m);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={s.row}
                      data-past={!live(m, now) || undefined}
                      onClick={() => onOpen(m.id)}
                    >
                      <span className={s.time}>
                        {timeOf(new Date(m.startsAt), tz)}
                        <span>{timeOf(new Date(m.endsAt), tz)}</span>
                      </span>
                      <i className={s.bar} aria-hidden />
                      <span className={s.rowBody}>
                        <b>{who(m)}</b>
                        <span>
                          {m.title}
                          {t ? ` · ${t}` : ""}
                        </span>
                      </span>
                      <svg
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.45"
                        aria-hidden
                      >
                        <path d="m6.2 3.4 4.5 4.6-4.5 4.6" />
                      </svg>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })
      )}

      <MeetingSheet
        meeting={opened}
        tz={tz}
        now={now}
        onClose={() => onOpen(null)}
        onLogOutcome={onLogOutcome}
      />
    </div>
  );
}

function Hero({
  meeting: m,
  tz,
  now,
  onOpen,
}: {
  meeting: Meeting;
  tz: string;
  now: Date;
  onOpen: (id: string) => void;
}) {
  const start = new Date(m.startsAt);
  const soon = meetingState(m, now) === "soon";
  const mins = Math.max(0, Math.ceil((start.getTime() - now.getTime()) / MIN));
  const when = soon ? (mins > 0 ? `in ${mins} min` : "now") : nearDay(start, tz, now).split(",")[0];
  return (
    <section className={s.hero} aria-label="Next meeting" data-soon={soon || undefined}>
      <p className={s.kicker}>
        {soon && <i aria-hidden />}
        Next · {when}
      </p>
      <b className={s.heroName}>{who(m)}</b>
      <p className={s.heroLine}>
        {m.matchedBy === "calendly" ? (
          <img src="/brand/calendly.svg" alt="" width={15} height={15} />
        ) : (
          <span className={s.gtile}>
            <img src="/brand/google-calendar.png" alt="" width={11} height={11} />
          </span>
        )}
        {m.title}, {timeRange(start, new Date(m.endsAt), tz)}
      </p>
      {soon && m.link ? (
        <a className={s.primary} href={m.link} target="_blank" rel="noopener noreferrer">
          <VideoIcon />
          Join
        </a>
      ) : (
        <button type="button" className={s.secondary} onClick={() => onOpen(m.id)}>
          See the meeting
        </button>
      )}
    </section>
  );
}

const VideoIcon = () => (
  <svg
    viewBox="0 0 16 16"
    width="17"
    height="17"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.45"
    aria-hidden
  >
    <rect x="1.7" y="4" width="8.8" height="8" rx="1.8" />
    <path d="m10.5 7 3.8-2.1v6.2L10.5 9" />
  </svg>
);

/** How far up past rest the sheet can be pulled, for the rubber band. */
const STRETCH = 300;

/**
 * The meeting's bottom sheet: dragged by its handle, it follows the finger down and resists upward; let go, it
 * closes when where it was headed (velocity projected) is past 220 px, or springs back. Join for a call to
 * come, Log how it went for one that ended; then Open lead and Copy link.
 */
function MeetingSheet({
  meeting,
  tz,
  now,
  onClose,
  onLogOutcome,
}: {
  meeting: Meeting | null;
  tz: string;
  now: Date;
  onClose: () => void;
  onLogOutcome: (m: Meeting) => void;
}) {
  // The last meeting shown stays in the sheet while it slides away.
  const [shown, setShown] = useState<Meeting | null>(meeting);
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const drag = useRef<{ from: number; samples: [number, number][] } | null>(null);
  const sheet = useRef<HTMLElement>(null);
  const open = !!meeting;

  useEffect(() => {
    if (!meeting) return;
    setShown(meeting);
    setDy(0);
    setCopied(false);
    sheet.current?.focus({ preventScroll: true });
  }, [meeting]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { from: e.clientY - dy, samples: [[performance.now(), e.clientY]] };
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const raw = e.clientY - d.from;
    setDy(raw < 0 ? rubberband(raw, STRETCH) : raw);
    d.samples = [...d.samples, [performance.now(), e.clientY] as [number, number]].slice(-5);
  };
  const up = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (sheetDismisses(dy, releaseVelocity(d.samples))) onClose();
    else setDy(0);
  };

  const copy = async () => {
    if (!shown?.link) return;
    try {
      await navigator.clipboard.writeText(shown.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard (an old browser, or permission refused): the button stays as it was.
    }
  };

  const m = shown;
  const start = m ? new Date(m.startsAt) : null;
  const day = start ? nearDay(start, tz, now).split(",")[0] : "";
  const state = m ? meetingState(m, now) : null;
  return (
    <>
      {open && <button type="button" className={s.veil} aria-label="Close" onClick={onClose} />}
      <section
        ref={sheet}
        className={s.sheet}
        data-open={open || undefined}
        data-dragging={dragging || undefined}
        role="dialog"
        aria-modal={open || undefined}
        aria-label={m ? who(m) : "Meeting"}
        aria-hidden={!open || undefined}
        inert={!open || undefined}
        tabIndex={-1}
        style={{ transform: open ? `translateY(${dy}px)` : "translateY(105%)" }}
      >
        <button
          type="button"
          className={s.grab}
          aria-label="Drag down to close"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onClick={(e) => e.detail === 0 && onClose()}
        >
          <i />
        </button>
        {m && start && (
          <>
            <div>
              <p className={s.sheetSub}>
                {day === "Today" ? "" : `${day} · `}
                {timeRange(start, new Date(m.endsAt), tz)} · {m.title}
              </p>
              <h2 className={s.sheetTitle}>{who(m)}</h2>
            </div>
            {m.link && (state === "soon" || state === "scheduled") && (
              <a className={s.primary} href={m.link} target="_blank" rel="noopener noreferrer">
                <VideoIcon />
                Join
              </a>
            )}
            {state === "needsOutcome" && (
              <button type="button" className={s.primary} onClick={() => onLogOutcome(m)}>
                <svg
                  viewBox="0 0 16 16"
                  width="17"
                  height="17"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.45"
                  aria-hidden
                >
                  <path d="M3 2.5h7.5L13 5v8.5H3z" />
                  <path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" />
                </svg>
                Log how it went
              </button>
            )}
            <div className={s.tiles}>
              {m.lead && (
                <Link className={s.tile} href={`/leads?lead=${m.lead.id}`}>
                  <span className={s.tileIcon} data-tone="lead" aria-hidden>
                    <svg
                      viewBox="0 0 16 16"
                      width="17"
                      height="17"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.45"
                    >
                      <circle cx="8" cy="5.4" r="2.6" />
                      <path d="M2.8 13.6c.6-2.5 2.6-3.9 5.2-3.9s4.6 1.4 5.2 3.9" />
                    </svg>
                  </span>
                  Open lead
                </Link>
              )}
              {m.link && (
                <button type="button" className={s.tile} onClick={() => void copy()}>
                  <span className={s.tileIcon} data-done={copied || undefined} aria-hidden>
                    <svg
                      viewBox="0 0 16 16"
                      width="17"
                      height="17"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.45"
                    >
                      {copied ? (
                        <path d="m3.5 8.5 3 3 6-7" />
                      ) : (
                        <>
                          <rect x="5" y="5" width="8.5" height="8.5" rx="1.6" />
                          <path d="M11 5V3.8A1.3 1.3 0 0 0 9.7 2.5H3.8a1.3 1.3 0 0 0-1.3 1.3v5.9A1.3 1.3 0 0 0 3.8 11H5" />
                        </>
                      )}
                    </svg>
                  </span>
                  {copied ? "Copied" : "Copy link"}
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
