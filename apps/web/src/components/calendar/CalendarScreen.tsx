"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "@/components/ui/Popover";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  addDays,
  agendaDays,
  dayKey,
  dayStart,
  filterMeetings,
  meetingState,
  writeCalendarUrl,
  type CalendarUrl,
} from "@/lib/calendar/agenda";
import { calendarClient } from "@/lib/calendar/client";
import type { LastSync, Meeting } from "@/lib/calendar/types";
import { useAgo } from "@/lib/ago";
import { longDate, weekOf } from "@/lib/dates";
import { tokenColor } from "@/lib/leads/colors";
import { usePhone } from "@/lib/usePhone";
import { Agenda } from "./Agenda";
import { MeetingDrawer } from "./MeetingDrawer";
import { CalendarRail } from "./CalendarRail";
import { CalendarRefresh } from "./CalendarRefresh";
import { ConnectCalendar } from "./ConnectCalendar";
import { LogOutcome } from "./LogOutcome";
import { PhoneCalendar } from "./PhoneCalendar";
import { WeekGrid } from "./WeekGrid";
import s from "./calendar.module.css";

export type CalendarScreenProps = {
  /** The person looking: "Mine" means theirs. */
  me: string;
  /** The business's clock: every day and time on the page is on it. */
  tz: string;
  weekStart: "monday" | "sunday";
  /** Everyone or Mine is offered only when calendar.view reaches beyond the person's own. */
  everyone: boolean;
  people: { id: string; name: string }[];
  stages: { id: string; name: string; color: string }[];
  initial: CalendarUrl;
  /** Where the meetings come from, for the source line and the rail ("Reading from"). */
  /** Where meetings come from; Google's `syncedAt` is when it was last read (the screen says how long ago, live). */
  sources?: { google: { syncedAt: string | null; healthy: boolean } | null; calendly: boolean };
  /** Refresh (Task 6), for someone with a connected calendar; "Connect again" when Google withdrew it. */
  refreshable?: { needsReconnect: boolean } | null;
  /** The settings gear (Task 7) sits at the bar's end. */
  gear?: ReactNode;
  /**
   * Connecting (Task 5): "connect" when this person may connect and hasn't; "off" or "unavailable" when the
   * module isn't there; "noPermission" for a role that doesn't connect. Null once connected.
   */
  connect?: { state: "connect" | "off" | "unavailable" | "noPermission"; admin: boolean } | null;

  now?: () => Date;
};

const DAY = 86_400_000;
/** The range read at once: a little before the chosen day's month, and about two months on (the API's cap is 100 days). */
const BEFORE_DAYS = 38;
const AFTER_DAYS = 60;

const IconAgenda = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
  </svg>
);
const IconWeek = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden
  >
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M3 9h18M9 9v11M15 9v11" />
  </svg>
);
const Chevron = ({ back }: { back?: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden
  >
    <path d={back ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
  </svg>
);

/**
 * The Calendar (Phase 5 canvas, Main): meetings with leads only, on the business's clock. The agenda groups
 * up to three days that have meetings from the chosen day on; the week lays them out 8 am–8 pm; the rail
 * jumps the agenda and says how the week went. The address bar mirrors the view, the day and the open meeting.
 */
export function CalendarScreen({
  me,
  tz,
  weekStart,
  everyone,
  people,
  stages,
  initial,
  sources,
  refreshable = null,
  gear,
  connect = null,
  now: nowOf = () => new Date(),
}: CalendarScreenProps) {
  const [now, setNow] = useState(nowOf);
  // "updated just now" the moment a Refresh reads the calendar, and kept true as time passes (owner, 2026-10-05).
  const [syncedAt, setSyncedAt] = useState(sources?.google?.syncedAt ?? null);
  const updated = useAgo(syncedAt);
  const live = sources && {
    calendly: sources.calendly,
    google: sources.google && { healthy: sources.google.healthy, updated },
  };
  const today = dayKey(now, tz);
  const [view, setView] = useState(initial.view);
  const [day, setDay] = useState(initial.day ?? today);
  const [open, setOpen] = useState<string | null>(initial.meeting);
  const [mine, setMine] = useState(!everyone);
  const [stageId, setStageId] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The meeting whose outcome is being logged (Task 11). */
  const [logging, setLogging] = useState<Meeting | null>(null);
  const onLogOutcome = (m: Meeting) => setLogging(m);
  /** Rows a Refresh brought or changed: they wash blue once. */
  const [washed, setWashed] = useState<Set<string>>(new Set());
  const range = useRef<{ from: number; to: number } | null>(null);

  // The minute moves on: starting soon and needs its outcome follow the clock.
  useEffect(() => {
    const t = setInterval(() => setNow(nowOf()), 30_000);
    return () => clearInterval(t);
  }, [nowOf]);

  const load = useCallback(
    async (around: string) => {
      const start = dayStart(around, tz).getTime();
      const from = new Date(start - BEFORE_DAYS * DAY);
      const to = new Date(start + AFTER_DAYS * DAY);
      const r = await calendarClient.meetings({ from, to });
      if (!r.ok) return setError(r.message);
      range.current = { from: from.getTime(), to: to.getTime() };
      setError(null);
      setMeetings(r.data.meetings);
    },
    [tz],
  );
  // After a Refresh: read again, and wash the rows that are new or changed.
  const synced = useCallback(async () => {
    const before = new Map(
      (meetings ?? []).map((m) => [m.id, `${m.startsAt}|${m.endsAt}|${m.title}|${m.status}`]),
    );
    const start = dayStart(day, tz).getTime();
    const r = await calendarClient.meetings({
      from: new Date(start - BEFORE_DAYS * DAY),
      to: new Date(start + AFTER_DAYS * DAY),
    });
    if (!r.ok) return;
    setMeetings(r.data.meetings);
    const changed = r.data.meetings
      .filter((m) => before.get(m.id) !== `${m.startsAt}|${m.endsAt}|${m.title}|${m.status}`)
      .map((m) => m.id);
    setWashed(new Set(changed));
    setTimeout(() => setWashed(new Set()), 2400);
  }, [meetings, day, tz]);
  const onRead = (l: LastSync) => {
    setSyncedAt(l.at);
    void synced();
  };

  // Read again only when the chosen day leaves what's loaded (with a week to spare either side).
  useEffect(() => {
    const t = dayStart(day, tz).getTime();
    const r = range.current;
    if (!r || t - 7 * DAY < r.from || t + 21 * DAY > r.to) void load(day);
  }, [day, tz, load]);

  // The address bar: a reload or a shared link opens the same view, day and meeting.
  useEffect(() => {
    const qs = writeCalendarUrl({ view, day: day === today ? null : day, meeting: open });
    const url = `${window.location.pathname}${qs}`;
    if (url !== window.location.pathname + window.location.search) window.history.replaceState(null, "", url);
  }, [view, day, open, today]);

  const shown = useMemo(
    () => filterMeetings(meetings ?? [], { mineOf: mine ? me : null, stageId }),
    [meetings, mine, me, stageId],
  );
  const week = useMemo(() => weekOf(day, weekStart), [day, weekStart]);
  const step = view === "week" ? 7 : 1;
  const opened = open ? ((meetings ?? []).find((m) => m.id === open) ?? null) : null;

  // Keyboard: T today, ← and → move (a day, or a week); R is Refresh's (Task 6). Never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (
        t?.closest(
          "input, textarea, select, [contenteditable='true'], [role='menu'], [role='radiogroup'], [role='dialog']",
        )
      )
        return;
      if (e.key === "t" || e.key === "T") setDay(today);
      else if (e.key === "ArrowRight") setDay((d) => addDays(d, step));
      else if (e.key === "ArrowLeft") setDay((d) => addDays(d, -step));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [today, step]);

  const phone = usePhone();
  // About connecting, above the agenda; on a phone, under the title.
  const notice =
    connect && connect.state !== "connect" ? (
      <ConnectCalendar state={connect.state} admin={connect.admin} />
    ) : connect?.state === "connect" && meetings && meetings.length > 0 ? (
      <ConnectCalendar state="connect" admin={connect.admin} compact />
    ) : null;
  const stageName = stages.find((x) => x.id === stageId)?.name;
  const days = agendaDays(shown, day, tz, now);

  return (
    <div className={s.page} data-view={phone ? "phone" : view}>
      {!phone && (
        <div className={s.bar}>
          <button
            type="button"
            className={s.ibtn}
            aria-label={view === "week" ? "Previous week" : "Previous day"}
            onClick={() => setDay((d) => addDays(d, -step))}
          >
            <Chevron back />
          </button>
          <button type="button" className={s.todayBtn} onClick={() => setDay(today)} disabled={day === today}>
            Today
          </button>
          <button
            type="button"
            className={s.ibtn}
            aria-label={view === "week" ? "Next week" : "Next day"}
            onClick={() => setDay((d) => addDays(d, step))}
          >
            <Chevron />
          </button>
          <h1 className={s.titleDate}>
            {(() => {
              const [date, weekday] = longDate(dayStart(day, tz), tz).split(", ");
              return (
                <>
                  {date}, <span>{weekday}</span>
                </>
              );
            })()}
          </h1>
          <div className={s.controls}>
            {everyone && (
              <SegmentedControl
                label="Whose meetings"
                value={mine ? "mine" : "everyone"}
                options={[
                  { value: "everyone", label: "Everyone" },
                  { value: "mine", label: "Mine" },
                ]}
                onChange={(v) => setMine(v === "mine")}
              />
            )}
            <Popover
              label="Stage"
              role="menu"
              triggerClassName={s.chip}
              active={!!stageId}
              trigger={
                <>
                  {stageId && (
                    <i
                      className={s.dot}
                      style={{ background: tokenColor(stages.find((x) => x.id === stageId)?.color) }}
                    />
                  )}
                  {stageName ?? "Any stage"}
                  <Chevron />
                </>
              }
            >
              {(close) => (
                <div className={s.menu}>
                  {[{ id: null, name: "Any stage", color: "neutral" }, ...stages].map((st) => (
                    <button
                      key={st.id ?? "any"}
                      type="button"
                      role="menuitemradio"
                      aria-checked={st.id === stageId}
                      className={s.menuItem}
                      onClick={() => {
                        close();
                        setStageId(st.id);
                      }}
                    >
                      {st.id && <i className={s.dot} style={{ background: tokenColor(st.color) }} />}
                      {st.name}
                    </button>
                  ))}
                </div>
              )}
            </Popover>
            {refreshable && <CalendarRefresh needsReconnect={refreshable.needsReconnect} onSynced={onRead} />}
            <SegmentedControl
              label="View"
              value={view}
              options={[
                { value: "agenda", label: "Agenda", icon: IconAgenda },
                { value: "week", label: "Week", icon: IconWeek },
              ]}
              onChange={setView}
            />
            {gear}
          </div>
        </div>
      )}

      {!phone && (
        <div className={s.lines}>
          <span className={s.privacy}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
              className={s.lock}
            >
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            Meetings with leads only. Personal events are read only to find them, and never kept.
          </span>
          {sources && (sources.google || sources.calendly) && (
            <span className={s.sources}>
              {sources.google && (
                <span className={s.src}>
                  <img className={s.gmark} src="/brand/google-calendar.png" alt="" width={14} height={14} />
                  Google Calendar{updated ? ` · updated ${updated}` : ""}
                </span>
              )}
              {sources.google && sources.calendly && <span aria-hidden>·</span>}
              {sources.calendly && (
                <span className={s.src}>
                  <img src="/brand/calendly.svg" alt="" width={14} height={14} />
                  Calendly bookings arrive on their own
                </span>
              )}
            </span>
          )}
        </div>
      )}

      {!phone && notice}
      {connect?.state === "connect" && meetings && meetings.length === 0 ? (
        <div className={s.connectStage}>
          <div className={s.ghost} data-testid="ghost-agenda" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} style={{ ["--w" as string]: `${[62, 78, 54, 70, 46][i]}%` }} />
            ))}
          </div>
          <div className={s.connectOver}>
            <ConnectCalendar state="connect" admin={connect.admin} />
          </div>
        </div>
      ) : error && !meetings ? (
        <p role="alert" className={s.error}>
          {error}
        </p>
      ) : phone ? (
        meetings && (
          <PhoneCalendar
            meetings={shown}
            tz={tz}
            now={now}
            me={me}
            people={people}
            openId={open}
            onOpen={setOpen}
            onLogOutcome={onLogOutcome}
            notice={notice}
            actions={
              (refreshable || gear) && (
                <>
                  {refreshable && (
                    <CalendarRefresh needsReconnect={refreshable.needsReconnect} onSynced={onRead} />
                  )}
                  {gear}
                </>
              )
            }
          />
        )
      ) : (
        <div className={s.body}>
          <div className={s.main} aria-busy={!meetings}>
            {meetings &&
              (view === "agenda" ? (
                <Agenda
                  days={days}
                  tz={tz}
                  now={now}
                  people={people}
                  stages={stages}
                  openId={open}
                  washed={washed}
                  onOpen={setOpen}
                  onLogOutcome={onLogOutcome}
                  onToday={day === today ? undefined : () => setDay(today)}
                />
              ) : (
                <WeekGrid
                  meetings={shown}
                  week={week}
                  tz={tz}
                  now={now}
                  today={today}
                  openId={open}
                  onOpen={setOpen}
                />
              ))}
          </div>
          {view === "agenda" && meetings && (
            <CalendarRail
              meetings={shown}
              day={day}
              today={today}
              week={week}
              tz={tz}
              now={now}
              weekStart={weekStart}
              sources={live}
              onPick={setDay}
              onLogOutcome={onLogOutcome}
            />
          )}
        </div>
      )}

      {!phone && (
        <MeetingDrawer
          meeting={opened}
          tz={tz}
          now={now}
          state={opened ? meetingState(opened, now) : null}
          owner={opened ? (people.find((p) => p.id === opened.ownerId)?.name ?? null) : null}
          stage={opened?.lead ? (stages.find((x) => x.id === opened.lead!.stageId) ?? null) : null}
          onClose={() => setOpen(null)}
          onLogOutcome={onLogOutcome}
        />
      )}
      {logging && (
        <LogOutcome
          meeting={logging}
          tz={tz}
          onClose={() => setLogging(null)}
          onDone={() => {
            setLogging(null);
            void synced();
          }}
        />
      )}
    </div>
  );
}
