"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import s from "./calendar.module.css";

/** The Calendar view the gear left from, so "‹ Calendar" (and browser Back) return to it. */
export const BACK_KEY = "lume:calendar:back";
const CALENDAR = /^\/calendar(\?[A-Za-z0-9_=&%-]*)?$/;

/** Where "‹ Calendar" goes: the remembered Calendar address, only ever a Calendar address. */
export function backToCalendar(): string {
  try {
    const v = sessionStorage.getItem(BACK_KEY);
    return v && CALENDAR.test(v) ? v : "/calendar";
  } catch {
    return "/calendar";
  }
}

type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => Promise<void> | void) => unknown };

/**
 * The gear (canvas Main): Settings → Calendar grows from it (the View Transitions API, the gear turning a
 * quarter as it goes); without the API, a short cross-fade. It remembers the exact Calendar view first.
 */
export function CalendarGear() {
  const router = useRouter();
  const [turning, setTurning] = useState(false);
  const go = () => {
    try {
      sessionStorage.setItem(BACK_KEY, window.location.pathname + window.location.search);
    } catch {
      // no storage: "‹ Calendar" opens the Calendar on today
    }
    setTurning(true);
    const doc = document as ViewTransitionDoc;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (doc.startViewTransition && !reduce)
      doc.startViewTransition(
        () =>
          new Promise<void>((done) => {
            router.push("/settings/calendar");
            // The new page paints within a frame or two of the push; the transition captures it then.
            setTimeout(done, 220);
          }),
      );
    else router.push("/settings/calendar");
  };
  return (
    <button
      type="button"
      className={s.gear}
      data-turning={turning || undefined}
      aria-label="Calendar settings"
      title="Calendar settings"
      onClick={go}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </svg>
    </button>
  );
}
