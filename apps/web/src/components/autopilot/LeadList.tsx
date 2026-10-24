"use client";
import type { LeadState } from "@lume/core/shared";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type { RunLead } from "@/lib/autopilot/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./live.module.css";

export const STATE_WORDS: Record<LeadState, string> = {
  up_next: "Up next",
  writing: "Writing",
  sent: "Sent",
  replied: "Replied",
  talking: "Talking",
  ready: "Ready for you",
  needs_you: "Needs you",
  stopped: "Stopped",
  with_you: "With you",
  skipped: "Skipped",
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/**
 * The leads in a run (spec 2026-10-19 §2): each with its state, the one LUME AI is on with the blue rail. Clicking one
 * watches its conversation while LUME AI carries on elsewhere. The skipped fold away at the end, each with why.
 */
export function LeadList({
  leads,
  currentId,
  watchedId,
  onWatch,
}: {
  leads: RunLead[];
  currentId: string | null;
  watchedId: string | null;
  onWatch(leadId: string): void;
}) {
  const reduce = useReducedMotion();
  const [showSkipped, setShowSkipped] = useState(false);
  const inRun = leads.filter((l) => l.state !== "skipped");
  const skipped = leads.filter((l) => l.state === "skipped");
  return (
    <div className={s.leadsCol}>
      <ul className={s.leads} aria-label="Leads in this run">
        <AnimatePresence initial={false}>
          {inRun.map((l) => {
            const current = l.leadId === currentId;
            return (
              <motion.li
                key={l.leadId}
                layout={reduce ? false : "position"}
                transition={toMotion(SPRINGS.default)}
              >
                <button
                  type="button"
                  className={s.leadRow}
                  data-current={current || undefined}
                  aria-pressed={l.leadId === watchedId}
                  aria-label={`${l.name}, ${STATE_WORDS[l.state]}${current ? ", LUME AI is on this lead" : ""}`}
                  onClick={() => onWatch(l.leadId)}
                >
                  <span className={s.avatar} aria-hidden>
                    {initials(l.name)}
                  </span>
                  <span className={s.leadName}>{l.name}</span>
                  <span className={s.stateChip} data-state={l.state}>
                    {STATE_WORDS[l.state]}
                  </span>
                </button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
      {skipped.length > 0 && (
        <div className={s.skippedBox}>
          <button
            type="button"
            className={s.skippedToggle}
            aria-expanded={showSkipped}
            onClick={() => setShowSkipped((x) => !x)}
          >
            {skipped.length.toLocaleString("en-US")} skipped
          </button>
          {showSkipped && (
            <ul className={s.skippedList}>
              {skipped.map((l) => (
                <li key={l.leadId}>
                  <b>{l.name}</b>
                  <span>{l.reason ?? "Skipped"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
