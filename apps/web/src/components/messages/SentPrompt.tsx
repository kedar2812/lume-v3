"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./messages.module.css";

export type Outcome = {
  /** Set once the server has answered; until then the tick shows "Sent" alone. */
  moved?: { stageId: string; stageName: string; fromStageId: string; undoable: boolean } | null;
  /** Answered Yes; LUME is saving it. The tick (and the sound) wait for the server. */
  pending?: boolean;
  refused?: string;
  failed?: string;
  undone?: boolean;
};

/**
 * "Sent?" once LUME has focus again (report §11.2 step 4): a small glass pill that rises out of the
 * WhatsApp button and, once answered, settles back into it. Yes draws a tick (with the `sent` sound, set
 * off by the same click) and says what the stage did, with Undo; a refused move says why.
 */
export function SentPrompt({
  asking,
  outcome,
  align = "start",
  inline = false,
  onAnswer,
  onUndo,
}: {
  asking: boolean;
  outcome: Outcome | null;
  align?: "start" | "end";
  /** In a row of its own (the drawer), opening room for itself rather than floating over what's below. */
  inline?: boolean;
  onAnswer: (sent: boolean) => void;
  onUndo: () => void;
}) {
  const reduce = useReducedMotion();
  const spring = reduce ? { duration: 0.15 } : toMotion(SPRINGS.default);
  // Floating, a pill rises from the button; in its own row, the row opens once and the pill's contents
  // change in place ("Sent?" → the tick), so nothing below jumps twice.
  const from = reduce
    ? { opacity: 0 }
    : inline
      ? { opacity: 0, scale: 0.97 }
      : { opacity: 0, y: -8, scale: 0.9 };
  const pill = {
    className: s.prompt,
    "data-align": align,
    "data-inline": inline || undefined,
    initial: from,
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: from,
    transition: spring,
  };
  const pills = (
    <AnimatePresence mode="wait" initial={!inline}>
      {asking && (
        <motion.div key="ask" role="group" aria-label="Was the WhatsApp message sent?" {...pill}>
          <span className={s.ask}>Sent?</span>
          <button type="button" className={`${s.pbtn} ${s.yes}`} onClick={() => onAnswer(true)}>
            Yes, sent
          </button>
          <button type="button" className={s.pbtn} onClick={() => onAnswer(false)}>
            Not sent
          </button>
        </motion.div>
      )}
      {!asking && outcome && (
        <motion.div key="done" role="status" {...pill}>
          {!outcome.failed && !outcome.pending && (
            <svg viewBox="0 0 16 16" width="14" height="14" className={s.tick} aria-hidden data-tick>
              <motion.path
                d="M3.5 8.5 6.5 11.5 12.5 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: reduce ? 1 : 0 }}
                animate={{ pathLength: 1 }}
                transition={reduce ? { duration: 0 } : toMotion(SPRINGS.default)}
              />
            </svg>
          )}
          <span className={s.said} data-failed={outcome.failed ? true : undefined}>
            {outcome.failed ? (
              outcome.failed
            ) : outcome.undone ? (
              "Sent · Moved back"
            ) : (
              <>
                Sent
                {outcome.moved && <> · Moved to {outcome.moved.stageName}</>}
                {outcome.refused && <span className={s.refused}>{outcome.refused}</span>}
              </>
            )}
          </span>
          {outcome.moved?.undoable && !outcome.undone && (
            <button type="button" className={s.undo} onClick={onUndo}>
              Undo
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
  if (!inline) return pills;
  return (
    <AnimatePresence>
      {(asking || outcome) && (
        <motion.div
          key="row"
          className={s.promptRow}
          initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={spring}
        >
          {pills}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
