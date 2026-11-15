"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/ErrorState";
import { IconButton } from "@/components/ui/IconButton";
import { Scrim } from "@/components/ui/Scrim";
import { useModalFocus } from "@/components/ui/useModalFocus";
import { addDays, dayKey, longDate } from "@/lib/dates";
import type { TodayView } from "@/lib/tasks/types";
import { KINDS, dayItems } from "@/lib/today/day-items";
import { clampPph } from "@/lib/today/timeline-math";
import { DayEmpty, DayList, type DayMode, type Show } from "./DayList";
import { DayTimeline } from "./DayTimeline";
import s from "./day.module.css";
import { readPrefs, writePrefs } from "./prefs";
import { useDayData } from "./useDayData";

/** How far either side of today: a year, and a day for the leap (the API's own limit). */
const RANGE = 366;
const STEP = 1.35;
const EASE = "cubic-bezier(.2,.8,.2,1)";

const reduced = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Your day, full screen (spec: Your day full screen, Part 2): it grows out of the card and shrinks back into it; the
 * header moves between days, picks what to show and how; the body is the timeline or the list.
 */
export function DayFull({
  v,
  now,
  tz,
  from,
  onClose,
}: {
  v: TodayView;
  now: Date;
  tz: string;
  /** The card it grows out of and shrinks back into. */
  from: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const today = dayKey(now, tz);
  // The day shown stays put when the clock passes midnight: it's whichever day was opened or moved to.
  const [day, setDay] = useState(today);
  const [prefs, setPrefs] = useState(readPrefs);
  const [fit, setFit] = useState(0);
  const [ready, setReady] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const { view, show, pph } = prefs;
  const set = (p: Partial<typeof prefs>) => setPrefs((x) => ({ ...x, ...p }));
  useEffect(() => writePrefs(prefs), [prefs]);

  const data = useDayData(day, today, v);
  const items = useMemo(
    () => (data.data ? dayItems(data.data, data.of, now, tz) : []),
    [data.data, data.of, now, tz],
  );
  // While another day loads, the last one stays (faded), shown as what it is.
  const mode: DayMode = data.of === today ? "today" : data.of < today ? "past" : "future";
  const shown = show === "all" ? items : items.filter((i) => i.kind === show);
  const calls = shown.filter((i) => i.kind === "call").length;
  const fus = shown.filter((i) => i.kind === "follow_up").length;
  const count =
    show === "call"
      ? plural(calls, "call", "calls")
      : show === "follow_up"
        ? plural(fus, "follow-up", "follow-ups")
        : `${plural(calls, "call", "calls")} · ${plural(fus, "follow-up", "follow-ups")}`;

  const eff = fit ? clampPph(pph || fit, fit) : 0;
  const zoom = (factor: number) => fit && set({ pph: clampPph(eff * factor, fit) });

  /** The card's box against the window's, as a transform from the open window to the card. */
  const fromCard = (): string | null => {
    const c = from.current?.getBoundingClientRect();
    const p = panel.current?.getBoundingClientRect();
    if (!c || !p || !p.width || !p.height) return null;
    return `translate(${c.left - p.left}px, ${c.top - p.top}px) scale(${c.width / p.width}, ${c.height / p.height})`;
  };
  const play = (open: boolean): Promise<unknown> => {
    const el = panel.current;
    if (!el || typeof el.animate !== "function") return Promise.resolve();
    const card = reduced() ? null : fromCard();
    const frames: Keyframe[] = card
      ? [{ transform: card, borderRadius: "22px" }, { transform: "none" }]
      : [{ opacity: 0 }, { opacity: 1 }];
    const a = el.animate(open ? frames : [...frames].reverse(), {
      duration: card ? 440 : 150,
      easing: EASE,
      fill: "both",
    });
    return a.finished.catch(() => undefined);
  };

  useLayoutEffect(() => {
    void play(true).then(() => setReady(true));
    // Once, as it opens.
  }, []);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    setReady(false);
    const opener = from.current?.querySelector<HTMLElement>('[aria-label="Open Your day full screen"]');
    void play(false).then(() => {
      onClose();
      setTimeout(() => opener?.focus(), 0);
    });
  };
  const focus = useModalFocus(panel, close);

  const min = addDays(today, -RANGE);
  const max = addDays(today, RANGE);
  const shownDate = longDate(new Date(`${day}T12:00:00Z`), "UTC");

  return (
    <Scrim onClose={close} className={s.fullLayer}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="your-day-full"
        className={s.full}
        data-ready={ready || undefined}
        onKeyDown={focus.onKeyDown}
      >
        <header className={s.fullHead}>
          <div className={s.fullTitle}>
            <h2 id="your-day-full">Your day</h2>
            <p>{shownDate}</p>
          </div>
          <div className={s.days}>
            <IconButton label="Previous day" disabled={day <= min} onClick={() => setDay(addDays(day, -1))}>
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M10 3 5 8l5 5" />
              </svg>
            </IconButton>
            <IconButton label="Next day" disabled={day >= max} onClick={() => setDay(addDays(day, 1))}>
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="m6 3 5 5-5 5" />
              </svg>
            </IconButton>
            {day !== today && (
              <Button size="sm" onClick={() => setDay(today)}>
                Today
              </Button>
            )}
          </div>
          <span className={s.count}>{count}</span>
          <div className={s.controls}>
            <Segmented
              label="Show"
              value={show}
              options={[
                { value: "all", label: "All" },
                ...KINDS.map((k) => ({ value: k.kind as Show, label: k.label })),
              ]}
              onChange={(v) => set({ show: v })}
            />
            <Segmented
              label="View"
              value={view}
              options={[
                { value: "timeline", label: "Timeline" },
                { value: "list", label: "List" },
              ]}
              onChange={(v) => set({ view: v })}
            />
            {view === "timeline" && (
              <div className={s.zoom}>
                <IconButton label="Zoom out" disabled={!fit || eff <= fit} onClick={() => zoom(1 / STEP)}>
                  <svg
                    viewBox="0 0 16 16"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    aria-hidden
                  >
                    <path d="M3.5 8h9" />
                  </svg>
                </IconButton>
                <output className={s.zoomLevel} data-testid="zoom-level" aria-live="polite">
                  {fit ? `${Math.round((eff / fit) * 100)}%` : "100%"}
                </output>
                <IconButton label="Zoom in" disabled={!fit} onClick={() => zoom(STEP)}>
                  <svg
                    viewBox="0 0 16 16"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    aria-hidden
                  >
                    <path d="M3.5 8h9M8 3.5v9" />
                  </svg>
                </IconButton>
                <Button size="sm" variant="ghost" onClick={() => set({ pph: 0 })}>
                  Fit day
                </Button>
              </div>
            )}
          </div>
          <IconButton label="Close" onClick={close}>
            <svg
              viewBox="0 0 14 14"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </IconButton>
        </header>
        <div className={s.fullBody} data-stale={data.stale || undefined} aria-busy={data.state === "loading"}>
          {data.state === "loading" && (
            <div className={s.loadingBar} role="status" aria-label="Getting the day" />
          )}
          {data.state === "error" ? (
            <div className={s.fullMessage}>
              <ErrorState
                message="LUME couldn't get this day. Check your connection and try again."
                action={{ label: "Try again", onClick: data.retry }}
              />
            </div>
          ) : !data.data ? (
            <div className={s.skeleton} aria-hidden>
              {[0, 1, 2, 3, 4].map((n) => (
                <i key={n} style={{ width: `${70 - n * 9}%` }} />
              ))}
            </div>
          ) : !shown.length ? (
            <DayEmpty mode={mode} />
          ) : view === "list" ? (
            <div className={s.listScroll}>
              <DayList items={items} mode={mode} show={show} now={now} tz={tz} />
            </div>
          ) : (
            <DayTimeline
              key={data.of}
              items={items}
              show={show}
              now={now}
              tz={tz}
              isToday={mode === "today"}
              pph={pph}
              onPph={(n) => set({ pph: n })}
              onFit={setFit}
            />
          )}
        </div>
      </div>
    </Scrim>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={s.seg}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={s.segOpt}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
