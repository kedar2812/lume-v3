"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { licenceClient } from "@/lib/licence/client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { useLicence } from "./LicenceProvider";
import s from "./announcement.module.css";

const dayIn = (iso: string, zone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" }).format(
    new Date(iso),
  );
const timeIn = (iso: string, zone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(iso))
    .replace(/\s?(AM|PM)$/, (_, m: string) => ` ${m.toLowerCase()}`);

/**
 * A maintenance window as the reader's day reads it: "Saturday, October 18 · 10:00 – 10:30 pm"; across midnight, both
 * days.
 */
export function windowText(start: string, end: string, zone: string): string {
  const d1 = dayIn(start, zone);
  const d2 = dayIn(end, zone);
  const t1 = timeIn(start, zone);
  const t2 = timeIn(end, zone);
  if (d1 !== d2) return `${d1}, ${t1} – ${d2}, ${t2}`;
  const same = t1.slice(-2) === t2.slice(-2);
  return `${d1} · ${same ? t1.slice(0, -3) : t1} – ${t2}`;
}

/**
 * From LUME's team (spec 2026-10-16 fleet §4): what the people who make LUME want this person to know, one at a time,
 * newest first, under the top bar. Got it is kept for them on every device; it comes back for no one else. No sound.
 */
export function AnnouncementStrip({ zone }: { zone: string }) {
  const { licence, set } = useLicence();
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const left = (licence.announcements ?? []).filter((a) => !a.gotIt);
  const a = left[0];
  const gotIt = async () => {
    if (!a || busy) return;
    setBusy(true);
    const r = await licenceClient.gotIt(a.id);
    setBusy(false);
    setOpen(false);
    if (r.ok) set(r.data);
  };
  const motionProps = {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: -6 },
    animate: { opacity: 1, y: 0 },
    exit: reduce ? { opacity: 0 } : { opacity: 0, y: -6 },
    transition: reduce ? { duration: 0.15 } : toMotion(SPRINGS.default),
  };
  return (
    <AnimatePresence initial={false} mode="wait">
      {a && (
        <motion.section key={a.id} aria-label="From LUME’s team" className={s.strip} {...motionProps}>
          <span className={s.dot} data-kind={a.kind} aria-hidden />
          <span className={s.words}>
            <span className={s.from}>
              From LUME’s team
              {left.length > 1 && ` · ${left.length - 1} more after this`}
            </span>
            <b className={s.title}>{a.title}</b>
            {a.windowStart && a.windowEnd && (
              <span className={s.window}>{windowText(a.windowStart, a.windowEnd, zone)}</span>
            )}
            <span className={s.body} data-open={open || undefined}>
              {a.body}
            </span>
            {a.body.length > 120 && (
              <button type="button" className={s.more} aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? "Less" : "More"}
              </button>
            )}
          </span>
          <button type="button" className={s.got} onClick={() => void gotIt()} disabled={busy}>
            Got it
          </button>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
