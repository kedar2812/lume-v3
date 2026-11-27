"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
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
  /** The grow (or fade) now playing: a close while it still runs turns it round from where it is. */
  const running = useRef<Animation | null>(null);
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
    running.current = a;
    return a.finished.catch(() => undefined);
  };

  useLayoutEffect(() => {
    void play(true).then(() => {
      if (closing.current) return;
      // Landed: let go of the animation (its held end state), so no browser keeps treating the window as a
      // transformed box that the panel inside it is placed and clipped against.
      running.current?.cancel();
      running.current = null;
    });
    // The insides come in a little after the window starts to grow, not after it lands.
    const t = setTimeout(() => !closing.current && setReady(true), 120);
    return () => clearTimeout(t);
    // Once, as it opens.
  }, []);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    setReady(false);
    const opener = from.current?.querySelector<HTMLElement>('[aria-label="Open Your day full screen"]');
    const still = running.current;
    let done: Promise<unknown>;
    if (still && still.playState === "running") {
      still.reverse();
      done = still.finished.catch(() => undefined);
    } else done = play(false);
    void done.then(() => {
      onClose();
      setTimeout(() => opener?.focus(), 0);
    });
  };
  const focus = useModalFocus(panel, close);
  /** Try again removes the button pressed: the keyboard stays in the window (Esc, Tab), not on the page. */
  const retry = () => {
    panel.current?.focus({ preventScroll: true });
    data.retry();
  };

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
        // Focusable itself: a press on empty timeline space keeps the keyboard (Esc, Tab) in here.
        tabIndex={-1}
        onKeyDown={focus.onKeyDown}
      >
        <header className={s.fullHead}>
          <div className={s.fullTitle}>
            <h2 id="your-day-full">Your day</h2>
            <p>{shownDate}</p>
          </div>
          <div className={s.days}>
            <IconButton label="Previous day" disabled={day <= min} onClick={() => setDay(addDays(day, -1))}>
              <UI_ICONS.before size={ICON_SIZE.sm} aria-hidden />
            </IconButton>
            <IconButton label="Next day" disabled={day >= max} onClick={() => setDay(addDays(day, 1))}>
              <UI_ICONS.after size={ICON_SIZE.sm} aria-hidden />
            </IconButton>
            {day !== today && (
              <Button size="sm" onClick={() => setDay(today)}>
                Today
              </Button>
            )}
          </div>
          {/* While another day loads, its count isn't known yet: no number from the day before. */}
          <span className={s.count}>{data.stale ? "" : count}</span>
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
                  <UI_ICONS.zoomOut size={ICON_SIZE.sm} aria-hidden />
                </IconButton>
                <output className={s.zoomLevel} data-testid="zoom-level" aria-live="polite">
                  {fit ? `${Math.round((eff / fit) * 100)}%` : "100%"}
                </output>
                <IconButton label="Zoom in" disabled={!fit} onClick={() => zoom(STEP)}>
                  <UI_ICONS.zoomIn size={ICON_SIZE.sm} aria-hidden />
                </IconButton>
                <Button size="sm" variant="ghost" onClick={() => set({ pph: 0 })}>
                  Fit day
                </Button>
              </div>
            )}
          </div>
          <IconButton label="Close" className={s.close} onClick={close}>
            <UI_ICONS.close size={ICON_SIZE.sm} aria-hidden />
          </IconButton>
        </header>
        <div className={s.fullBody} data-stale={data.stale || undefined} aria-busy={data.state === "loading"}>
          {data.refreshFailed && (
            <p className={s.note}>
              <span role="status">LUME couldn't refresh this day.</span>
              <Button size="sm" variant="ghost" onClick={retry}>
                Try again
              </Button>
            </p>
          )}
          {data.state === "loading" && (
            <div className={s.loadingBar} role="status" aria-label="Getting the day" />
          )}
          {data.state === "error" ? (
            <div className={s.fullMessage}>
              <ErrorState
                message="LUME couldn't get this day. Check your connection and try again."
                action={{ label: "Try again", onClick: retry }}
              />
            </div>
          ) : !data.data ? (
            <div className={s.skeleton} aria-hidden>
              {[0, 1, 2, 3, 4].map((n) => (
                <i key={n} style={{ width: `${70 - n * 9}%` }} />
              ))}
            </div>
          ) : !shown.length ? (
            <DayEmpty mode={mode} show={show} />
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
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  // A radio group: one Tab stop (the chosen option), the arrow keys choose within it and wrap round.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (at + step + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={s.seg} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === at ? 0 : -1}
          className={s.segOpt}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
