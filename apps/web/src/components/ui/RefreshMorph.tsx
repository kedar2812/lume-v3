"use client";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import s from "./refresh.module.css";

export type RefreshPhase = "idle" | "lifting" | "syncing" | "result" | "landing" | "landed";

const PILL = { w: 236, h: 40, r: 20 };
const CARD = { w: 330, h: 168, r: 22 };
// Apple's move/reposition spring: critically damped, no overshoot on a surface that simply grows.
const MORPH = { type: "spring", bounce: 0, duration: 0.6 } as const;
const FADE = { duration: 0.2 } as const;

export const Tick = ({ size }: { size: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
    <path
      d="M5.5 12.5 10 17l8.5-9.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** A layer materialises (opacity with a little blur) rather than simply fading; Reduce Motion: opacity only. */
export function layer(reduce: boolean) {
  return reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: FADE }
    : {
        initial: { opacity: 0, filter: "blur(4px)" },
        animate: { opacity: 1, filter: "blur(0px)" },
        exit: { opacity: 0, filter: "blur(4px)" },
        transition: { duration: 0.28 },
      };
}

/**
 * The Refresh morph (the approved v5 motion), shared by the leads' Refresh and the Calendar's: the button
 * lifts into a glass pill, the pill opens into the card, the result arrives, and the card settles back into
 * the button. The surface is one shape that springs between them; its layers materialise in turn.
 * Reduce Motion gets a still card that fades.
 */
export function RefreshMorph({
  phase,
  box,
  reduce,
  pill,
  card,
  result,
  face,
  warn,
}: {
  phase: RefreshPhase;
  /** The button's size, measured: the morph starts and ends exactly on it. */
  box: { w: number; h: number };
  reduce: boolean;
  pill: ReactNode;
  card: ReactNode;
  result: ReactNode;
  /** What the button says as the card lands ("✓ 3 new"). */
  face: ReactNode;
  warn?: boolean;
}) {
  const open = phase === "lifting" || phase === "syncing" || phase === "result" || phase === "landing";
  const at = (shape: "button" | "pill" | "card") =>
    shape === "button"
      ? { left: 0, top: 0, width: box.w, height: box.h, borderRadius: 9 }
      : shape === "pill"
        ? { left: box.w - PILL.w, top: box.h + 8, width: PILL.w, height: PILL.h, borderRadius: PILL.r }
        : { left: box.w - CARD.w, top: box.h + 8, width: CARD.w, height: CARD.h, borderRadius: CARD.r };
  const shape: Record<RefreshPhase, "button" | "pill" | "card"> = {
    idle: "button",
    lifting: "pill",
    syncing: "card",
    result: "card",
    landing: "button",
    landed: "button",
  };
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="morph"
          className={s.morph}
          data-glass={shape[phase] !== "button" || undefined}
          aria-hidden
          initial={reduce ? { opacity: 0, ...at("card") } : { opacity: 1, ...at("button") }}
          animate={
            reduce
              ? { opacity: phase === "landing" ? 0 : 1, ...at("card") }
              : { opacity: 1, ...at(shape[phase]) }
          }
          exit={{ opacity: 0, transition: FADE }}
          transition={reduce ? FADE : MORPH}
        >
          <AnimatePresence initial={false}>
            {phase === "lifting" && !reduce && (
              <motion.div key="pill" className={`${s.layer} ${s.pill}`} {...layer(reduce)}>
                {pill}
              </motion.div>
            )}
            {(phase === "syncing" || (reduce && phase === "lifting")) && (
              <motion.div key="card" className={`${s.layer} ${s.card}`} {...layer(reduce)}>
                {card}
              </motion.div>
            )}
            {phase === "result" && (
              <motion.div
                key="result"
                className={`${s.layer} ${s.result}`}
                data-warn={warn || undefined}
                {...layer(reduce)}
              >
                <motion.span
                  className={s.check}
                  initial={reduce ? false : { scale: 0.4 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", bounce: 0.35, duration: 0.6 }}
                >
                  {warn ? "!" : <Tick size={20} />}
                </motion.span>
                <div>{result}</div>
              </motion.div>
            )}
            {phase === "landing" && !reduce && (
              <motion.div key="face" className={`${s.layer} ${s.face}`} {...layer(reduce)}>
                {face}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
