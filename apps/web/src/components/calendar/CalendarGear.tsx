"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
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
      <UI_ICONS.settings size={ICON_SIZE.md} aria-hidden />
    </button>
  );
}
