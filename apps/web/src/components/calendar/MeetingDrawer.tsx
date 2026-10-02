"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Popover } from "@/components/ui/Popover";
import type { MeetingState } from "@/lib/calendar/agenda";
import type { Meeting } from "@/lib/calendar/types";
import { nearDay, timeOf } from "@/lib/dates";
import { tokenColor } from "@/lib/leads/colors";
import { SPRINGS, toMotion } from "@/lib/motion";
import { SourceMark, soonWords } from "./Agenda";
import s from "./calendar.module.css";

/** Why LUME kept this event, in words: the rule that matched it. */
const WHY: Record<Meeting["matchedBy"], string> = {
  attendee: "A lead is invited to it.",
  title: "Its title has one of your calendar words.",
  calendar: "It's on a calendar LUME keeps whole.",
  calendly: "It was booked through Calendly.",
};
const OUTCOME: Partial<Record<Meeting["status"], string>> = {
  completed: "Held",
  no_show: "No-show",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
};

/**
 * One meeting (canvas Main, the drawer): a glass panel from the right that leaves the way it came. Join,
 * Copy link (it says "Copied"), More (open the lead, copy), the lead, whose meeting it is and why it's here.
 * Esc closes it, after any menu open over it (the menu takes its own Esc first).
 */
export function MeetingDrawer({
  meeting: m,
  tz,
  now,
  state,
  owner,
  stage,
  onClose,
  onLogOutcome,
}: {
  meeting: Meeting | null;
  tz: string;
  now: Date;
  state: MeetingState | null;
  owner: string | null;
  stage: { id: string; name: string; color: string } | null;
  onClose: () => void;
  onLogOutcome?: (m: Meeting) => void;
}) {
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);
  // Held, not depended on: the page re-renders every 30 s, and focus must not move with it.
  const close = useRef(onClose);
  close.current = onClose;
  const mid = m?.id ?? null;
  const open = mid !== null;

  useEffect(() => setCopied(false), [m?.id]);
  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Focus goes back where it came from, so a keyboard person never gets lost.
      back.current?.focus?.();
    };
  }, [open, mid]);

  const copy = async () => {
    if (!m?.link) return;
    try {
      await navigator.clipboard.writeText(m.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // No clipboard (an old browser, a denied permission): the link is still on the page to copy by hand.
    }
  };

  const start = m ? new Date(m.startsAt) : null;
  const live = state === "soon" || state === "scheduled";
  return (
    <AnimatePresence>
      {m && start && (
        <motion.div
          key={m.id}
          ref={panel}
          role="dialog"
          aria-label={m.title}
          tabIndex={-1}
          className={s.drawer}
          initial={reduce ? { opacity: 0 } : { opacity: 1, x: "calc(100% + 24px)" }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 1, x: "calc(100% + 24px)" }}
          transition={toMotion(SPRINGS.drawer)}
        >
          <div className={s.dhead}>
            <div>
              <h2 className={s.dtitle}>{m.title}</h2>
              <p className={s.dwhen}>
                {nearDay(start, tz, now)} · {timeOf(start, tz)} – {timeOf(new Date(m.endsAt), tz)}
                {state === "soon" && (
                  <span className={s.soon}>
                    <i aria-hidden />
                    {soonWords(m, now)}
                  </span>
                )}
              </p>
            </div>
            <button type="button" className={s.ibtn} aria-label="Close" onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <div className={s.dactions}>
            {m.link && live && (
              <a
                className={state === "soon" ? s.join : s.btn}
                href={m.link}
                target="_blank"
                rel="noopener noreferrer"
              >
                Join
              </a>
            )}
            {m.link && (
              <button
                type="button"
                className={s.btn}
                data-copied={copied || undefined}
                onClick={() => void copy()}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            )}
            {state === "needsOutcome" && onLogOutcome && (
              <button type="button" className={s.outcomeBtn} onClick={() => onLogOutcome(m)}>
                Log outcome
              </button>
            )}
            <Popover label="More" role="menu" triggerClassName={s.btn} trigger="More" align="end">
              {(close) => (
                <div className={s.menu}>
                  {m.lead && (
                    <Link
                      role="menuitem"
                      className={s.menuItem}
                      href={`/leads?lead=${m.lead.id}`}
                      onClick={close}
                    >
                      Open the lead
                    </Link>
                  )}
                  {m.link && (
                    <button
                      type="button"
                      role="menuitem"
                      className={s.menuItem}
                      onClick={() => {
                        close();
                        void copy();
                      }}
                    >
                      Copy the meeting link
                    </button>
                  )}
                </div>
              )}
            </Popover>
          </div>

          {m.lead ? (
            <Link className={s.leadcard} href={`/leads?lead=${m.lead.id}`}>
              <Avatar name={m.lead.name} size={36} />
              <span>
                <b>{m.lead.name}</b>
                {stage && (
                  <span className={s.stage}>
                    <i className={s.dot} style={{ background: tokenColor(stage.color) }} />
                    {stage.name}
                  </span>
                )}
              </span>
            </Link>
          ) : (
            <p className={s.dnote}>Not with a lead yet.</p>
          )}

          <dl className={s.kv}>
            <dt>Whose meeting</dt>
            <dd>{owner ?? "Someone who has left"}</dd>
            <dt>Why it&apos;s here</dt>
            <dd className={s.why}>
              <SourceMark m={m} />
              {WHY[m.matchedBy]}
            </dd>
            {m.location && (
              <>
                <dt>Where</dt>
                <dd>{m.location}</dd>
              </>
            )}
            {OUTCOME[m.status] && (
              <>
                <dt>How it went</dt>
                <dd>
                  {OUTCOME[m.status]}
                  {m.outcomeNote ? ` · ${m.outcomeNote}` : ""}
                </dd>
              </>
            )}
          </dl>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
