"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Floating } from "./day/Floating";
import { IconButton } from "@/components/ui/IconButton";
import { dayKey, timeOf } from "@/lib/dates";
import type { TodayView } from "@/lib/tasks/types";
import { callsLeft } from "@/lib/today/brief";
import { dayItems, fromToday, openOf, type DayItem } from "@/lib/today/day-items";
import { clusterDots, dayline, type DayDot } from "@/lib/today/dayline";
import { GroupPanel, ItemPanel } from "./day/ItemPanel";
import d from "./day/day.module.css";
import { fixedPlace, panelHeight, useItemFocus } from "./day/useItemFocus";
import s from "./today.module.css";

const MIN = 60_000;
/** Room the "N from before" pill takes at the line's start, in px. */
const OLDER_ROOM = 104;
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const STATE = { done: "done", over: "overdue", soon: "due soon", later: "later today" } as const;

/** The day line's width in px, kept up to date: dots group by real distance, not by percent. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

/** A click that lands on something with its own job (an item, the panel, a link or a button) isn't the card's. */
const ownJob = (e: MouseEvent) =>
  e.target instanceof Element && !!e.target.closest("[data-day-item], [data-day-panel], a, button");

/**
 * Your day (spec: Your day): one line from morning to night with now on it — calls above, follow-ups on it by where
 * they stand, the ones from before today counted at its start — and the next call beneath, with Join. Hovering (or
 * tabbing onto) a thing brings it forward with its details (spec: Your day full screen, Part 1); a click anywhere
 * else on the card opens the full-screen day.
 */
export function DayTile({
  v,
  now,
  tz,
  onOpenFull,
  cardRef,
}: {
  v: TodayView;
  now: Date;
  tz: string;
  onOpenFull: () => void;
  /** The card itself: the full screen grows out of it and shrinks back into it. */
  cardRef?: Ref<HTMLElement>;
}) {
  const line = dayline(v, now, tz);
  const track = useWidth();
  const f = useItemFocus();
  const items = useMemo(
    () => new Map(dayItems(fromToday(v), dayKey(now, tz), now, tz).map((i) => [i.id, i])),
    [v, now, tz],
  );
  const next = callsLeft(v.meetings, now)[0];
  const calls = (v.meetings ?? []).filter((m) => m.status === "scheduled" || m.status === "completed").length;
  const fus = line.dots.length + line.older.length;
  const mins = next ? Math.round((Date.parse(next.startsAt) - now.getTime()) / MIN) : 0;
  const inWords =
    mins <= 0
      ? "Happening now"
      : mins < 60
        ? `In ${mins} min`
        : `In ${Math.floor(mins / 60)} h ${mins % 60 ? `${mins % 60} min` : ""}`.trim();
  const groups = clusterDots(line.dots, track.w);
  const shown: DayItem[] | null = useMemo(() => {
    const k = f.focused?.key;
    if (!k) return null;
    const ids = k.slice(2).split(":");
    const xs = ids.map((id) => items.get(id)).filter((i): i is DayItem => !!i);
    return xs.length ? xs : null;
  }, [f.focused, items]);
  // A thing that vanishes in a live update takes its panel with it, and the rest comes back.
  // Checked after each commit: a live update can also replace the marker a panel hangs on (its group changed).
  const vanished = !!f.focused && !shown;
  useEffect(() => {
    if (vanished || (f.focused && !f.focused.el.isConnected)) f.close();
  });

  return (
    <section
      ref={cardRef}
      className={`${s.tl} ${s.dayArea} ${s.dayOpen}`}
      style={{ "--i": 0 } as CSSProperties}
      aria-labelledby="your-day"
      data-your-day
      onClick={(e) => !ownJob(e) && onOpenFull()}
    >
      <div className={s.th}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
        <span id="your-day">Your day</span>
        <span className={s.r} data-live-count data-volatile-count>
          {calls || fus
            ? `${calls} ${calls === 1 ? "call" : "calls"} · ${fus} ${fus === 1 ? "follow-up" : "follow-ups"}`
            : "Nothing planned yet"}
        </span>
        <IconButton label="Open Your day full screen" className={s.expand} onClick={onOpenFull}>
          <UI_ICONS.fullScreen size={ICON_SIZE.sm} aria-hidden />
        </IconButton>
      </div>
      {/* Where now and each dot sit follows the hour: screenshots hide it (dots can sit past either end). */}
      <div
        className={f.focused ? `${s.day} ${d.focusing}` : s.day}
        data-live-count
        data-volatile-day
        data-day-line
      >
        {/* The line itself. With ones from before, it starts after their pill, so nothing can sit under it. */}
        <div
          ref={track.ref}
          className={s.lineIn}
          style={line.older.length > 0 ? { left: OLDER_ROOM } : undefined}
          data-day-line-in
        >
          <div className={s.rail} data-day-back>
            <i style={{ width: `${Math.max(0, Math.min(100, line.now))}%` }} />
          </div>
          {line.hours
            .filter((h) => h.h % 2 === 0 || h.h === line.to / 60)
            .filter((h) => Math.abs(h.left - line.now) > 6)
            .map((h) => (
              <span key={h.h} className={s.hour} style={{ left: `${h.left}%` }} aria-hidden data-day-back>
                {h.label}
              </span>
            ))}
          {line.calls.map((c, i) => {
            const key = `i:${c.id}`;
            // The same place as on the timeline (spec Part 1): an upcoming call with a link joins it.
            const it = items.get(c.id);
            const go = it
              ? openOf(it, now)
              : { href: c.m.lead ? `/leads?lead=${c.m.lead.id}` : `/calendar?m=${c.id}`, external: false };
            return (
              <GoLink
                key={c.id}
                go={go}
                className={s.call}
                data-done={c.done || undefined}
                data-day-item
                data-on={f.focused?.key === key || undefined}
                style={{ left: `${c.left}%`, "--i": i } as CSSProperties}
                aria-label={`${c.m.title} with ${c.m.lead?.name ?? "someone"} at ${timeOf(new Date(c.m.startsAt), tz)}${c.done ? ", over" : ""}`}
                {...f.bind(key)}
              >
                {c.done ? (
                  <UI_ICONS.done size={ICON_SIZE.md} aria-hidden />
                ) : (
                  <UI_ICONS.video size={ICON_SIZE.md} aria-hidden />
                )}
                {first(c.m.lead?.name ?? c.m.title)} {timeOf(new Date(c.m.startsAt), tz)}
              </GoLink>
            );
          })}
          {groups.map((g) => {
            const say = (t: DayDot) =>
              `${t.title}, ${t.leadName}, ${timeOf(new Date(t.dueAt), tz)}, ${STATE[t.state]}`;
            if (g.length === 1) {
              const t = g[0]!;
              const key = `i:${t.id}`;
              return (
                <Link
                  key={t.id}
                  href={`/leads?lead=${t.leadId}`}
                  className={s.dot}
                  data-state={t.state}
                  data-day-item
                  data-on={f.focused?.key === key || undefined}
                  style={{ left: `${t.left}%` }}
                  aria-label={say(t)}
                  {...f.bind(key)}
                />
              );
            }
            // Several at about the same time: one marker with their count, opening the list of all of them.
            const key = `g:${g.map((t) => t.id).join(":")}`;
            const top = [...g].sort(
              (a, b) =>
                (["over", "soon", "later", "done"] as const).indexOf(a.state) -
                (["over", "soon", "later", "done"] as const).indexOf(b.state),
            )[0]!;
            const bound = f.bind(key);
            return (
              <button
                key={key}
                type="button"
                className={`${s.dot} ${s.dots}`}
                data-state={top.state}
                data-day-item
                data-on={f.focused?.key === key || undefined}
                style={{ left: `${g[0]!.left}%` }}
                aria-label={`${g.length} follow-ups: ${g.map(say).join("; ")}`}
                aria-expanded={f.focused?.key === key}
                {...bound}
                onClick={(e) => {
                  bound.onClick(e);
                  f.open(key, e.currentTarget, { focusPanel: true });
                }}
              >
                {g.length}
              </button>
            );
          })}
          {line.now >= 0 && line.now <= 100 && (
            <div className={s.now} style={{ left: `${line.now}%` }} aria-hidden data-day-back>
              <b>{timeOf(now, tz).replace(/ (am|pm)$/, "")}</b>
            </div>
          )}
        </div>
        {line.older.length > 0 && (
          <Link
            href={`/leads?lead=${line.older[0]!.leadId}`}
            className={s.older}
            title={line.older.map((t) => t.leadName).join(", ")}
            data-day-back
          >
            {line.older.length} from before
          </Link>
        )}
      </div>
      {f.focused && shown && (
        <Floating
          el={f.focused.el}
          place={(el) => fixedPlace(el, { height: panelHeight(shown.length > 1 ? shown.length : 0) })}
        >
          {(style) =>
            shown.length === 1 && f.focused?.key.startsWith("i:") ? (
              <ItemPanel item={shown[0]!} now={now} tz={tz} style={style} {...f.panelBind} />
            ) : (
              <GroupPanel items={shown} now={now} tz={tz} style={style} {...f.panelBind} />
            )
          }
        </Floating>
      )}
      <div className={s.nextrow} data-next-call>
        <span className={s.vi} aria-hidden>
          <UI_ICONS.video size={ICON_SIZE.md} aria-hidden />
        </span>
        {next ? (
          <>
            <div style={{ minWidth: 0 }}>
              <b>
                {next.lead?.name ?? next.title}
                {next.lead ? ` · ${next.title}` : ""}
              </b>
              <span className={s.sub} data-live-count>
                Next call · {inWords}
              </span>
            </div>
            <time dateTime={next.startsAt}>{timeOf(new Date(next.startsAt), tz)}</time>
            {next.link ? (
              <a className={s.go} href={next.link} target="_blank" rel="noopener noreferrer">
                Join
              </a>
            ) : next.lead ? (
              <Link className={s.go} href={`/leads?lead=${next.lead.id}`}>
                Open lead
              </Link>
            ) : (
              <span />
            )}
          </>
        ) : (
          <>
            <div style={{ minWidth: 0 }}>
              <b>No calls left today</b>
              <span className={s.sub}>Calls on your calendar show here</span>
            </div>
            <span />
            <span />
          </>
        )}
      </div>
    </section>
  );
}

/** A link that opens in LUME, or (a call's meeting) in a new tab. */
function GoLink({
  go,
  children,
  ...p
}: {
  go: { href: string; external: boolean };
  children: ReactNode;
} & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return go.external ? (
    <a {...p} href={go.href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <Link {...p} href={go.href}>
      {children}
    </Link>
  );
}
