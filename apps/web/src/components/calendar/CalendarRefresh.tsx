"use client";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Odometer } from "@/components/ui/Odometer";
import { RefreshMorph, Tick } from "@/components/ui/RefreshMorph";
import s from "@/components/ui/refresh.module.css";
import { calendarClient } from "@/lib/calendar/client";
import type { LastSync } from "@/lib/calendar/types";
import { STILL_SYNCING, landedWords, syncWords, useCalendarRefresh } from "./useCalendarRefresh";

const Arrow = ({ spin }: { spin?: boolean }) => (
  <svg className={spin ? s.spin : undefined} viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path
      d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2.5v3h-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * The Calendar's Refresh (canvas Main): the same motion as the leads Refresh. "Syncing your calendar…" →
 * the card (the Google Calendar mark, meetings drifting into LUME, a blue bar) → what changed → back into the
 * button ("✓ 3 updated"). R presses it. A connection Google withdrew is "Connect again" instead.
 */
export function CalendarRefresh({
  onSynced,
  needsReconnect = false,
  shortcut = true,
}: {
  onSynced(l: LastSync): void;
  needsReconnect?: boolean;
  shortcut?: boolean;
}) {
  const reduce = !!useReducedMotion();
  const r = useCalendarRefresh({ reduce, needsReconnect, onSynced });
  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState({ w: 96, h: 32 });
  useLayoutEffect(() => {
    if (btn.current) setBox({ w: btn.current.offsetWidth, h: btn.current.offsetHeight });
  }, [r.phase]);

  const press = r.press;
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "r" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable], [role=dialog]"))
        return;
      e.preventDefault();
      btn.current?.focus();
      void press();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut, press]);

  const again = async () => {
    const c = await calendarClient.connect();
    if (c.ok) window.location.assign(c.data.url);
  };

  const busy = r.phase !== "idle";
  const warn = !!r.failure;
  const total = r.last ? r.last.added + r.last.moved + r.last.changed + r.last.cancelled : 0;
  const landed = warn ? "Try later" : landedWords(r.last);

  if (r.reconnect && (r.phase === "idle" || r.phase === "landed"))
    return (
      <span className={s.anchor}>
        <Button className={s.button} data-phase="reconnect" onClick={() => void again()}>
          Connect again
        </Button>
        <p role="status" aria-live="polite" className={s.srOnly}>
          {r.announce}
        </p>
      </span>
    );

  return (
    <span className={s.anchor}>
      <Button
        ref={btn}
        aria-disabled={busy || undefined}
        aria-keyshortcuts="R"
        title="Refresh (R)"
        className={s.button}
        data-phase={r.phase}
        onClick={() => void r.press()}
      >
        {r.phase === "landed" ? (
          <span className={s.landed} data-warn={warn || !r.last || undefined}>
            {!warn && r.last && <Tick size={13} />}
            {landed}
          </span>
        ) : (
          <>
            <Arrow spin={busy} />
            Refresh
          </>
        )}
      </Button>
      <RefreshMorph
        phase={r.phase}
        box={box}
        reduce={reduce}
        warn={warn}
        pill={
          <>
            <img src="/lume-mark.png" alt="" width={20} height={20} />
            Syncing your calendar…
          </>
        }
        card={
          <>
            <div className={s.route} data-flowing={!reduce || undefined}>
              <span className={`${s.end} ${s.sheet}`}>
                <img src="/brand/google-calendar.png" alt="" width={28} height={28} />
              </span>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span key={i} className={s.glyph} style={{ ["--i" as string]: i }} />
              ))}
              <span className={`${s.end} ${s.lume}`}>
                <img src="/lume-mark.png" alt="" width={28} height={28} />
              </span>
            </div>
            <p className={s.title}>Syncing your calendar</p>
            <p className={s.sub}>{r.step}</p>
            {/* The real progress of the sync (0061): it fills as calendars are read and reaches the end when done. */}
            <div
              className={s.bar}
              role="progressbar"
              aria-label="Syncing your calendar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(r.fraction * 100)}
            >
              <motion.i
                initial={{ width: "4%" }}
                animate={{ width: `${Math.max(4, r.fraction * 100)}%` }}
                transition={reduce ? { duration: 0 } : { type: "spring", bounce: 0, duration: 0.6 }}
              />
            </div>
          </>
        }
        result={
          warn ? (
            <>
              <p className={s.resultTitle}>Couldn&apos;t refresh</p>
              <p className={s.sub}>{r.failure}</p>
            </>
          ) : !r.last ? (
            <>
              <p className={s.resultTitle}>Still syncing</p>
              <p className={s.sub}>{STILL_SYNCING}</p>
            </>
          ) : total ? (
            <>
              <p className={s.count}>
                <Odometer value={total} />
              </p>
              <p className={s.sub}>{syncWords(r.last)}</p>
            </>
          ) : (
            <>
              <p className={s.resultTitle}>Up to date</p>
              <p className={s.sub}>Nothing changed since the last sync.</p>
            </>
          )
        }
        face={
          <>
            <Tick size={13} />
            {landed}
          </>
        }
      />
      <p role="status" aria-live="polite" className={s.srOnly}>
        {r.announce}
      </p>
    </span>
  );
}
