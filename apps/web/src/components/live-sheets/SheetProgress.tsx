"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import { motion, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./live-sheets.module.css";

export type ProgressPhase = "making" | "writing" | "slow" | "live";
const n = (v: number) => v.toLocaleString("en-US");

/**
 * A live sheet's progress (spec 2026-11-14 §5): a real bar of the rows Google has confirmed, with the step in words
 * under it. It never moves backwards (a count that arrives lower keeps the higher); "making" breathes while Google
 * makes the file, and "live" ends on a tick that draws itself. Reduced motion: the bar steps, nothing breathes.
 */
export function SheetProgress({
  phase,
  total,
  written,
  count,
}: {
  phase: ProgressPhase;
  total: number;
  written: number;
  /** Leads in the sheet, for the done state. */
  count?: number;
}) {
  const reduce = !!useReducedMotion();
  const most = useRef(0);
  most.current = Math.max(most.current, written);
  const shown = most.current;
  const frac = phase === "live" ? 1 : phase === "making" ? 0 : total > 0 ? Math.min(1, shown / total) : 0;
  const words =
    phase === "making"
      ? "Making your sheet in Google"
      : phase === "slow"
        ? "Google is slow right now; LUME will keep going."
        : phase === "live"
          ? `Live · ${n(count ?? shown)} ${(count ?? shown) === 1 ? "lead" : "leads"}`
          : `Writing leads: ${n(shown)} of ${n(total)}`;
  return (
    <div className={s.progress} data-phase={phase}>
      <div
        className={s.track}
        role="progressbar"
        aria-label={phase === "making" ? "Making your sheet" : "Writing leads"}
        aria-valuemin={0}
        aria-valuemax={Math.max(total, 1)}
        aria-valuenow={phase === "live" ? Math.max(total, 1) : shown}
        aria-valuetext={words}
      >
        {phase === "making" && !reduce && <span className={s.breathe} aria-hidden />}
        <motion.span
          className={s.fill}
          initial={false}
          animate={{ scaleX: frac }}
          transition={reduce ? { duration: 0 } : toMotion(SPRINGS.soft)}
        />
      </div>
      <p className={s.progressWords}>
        {phase === "live" && <UI_ICONS.done size={ICON_SIZE.md} aria-hidden className={s.tick} />}
        {words}
      </p>
    </div>
  );
}
