"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./messages.module.css";

export type Outcome = {
  /** Set once the server has answered; until then the tick shows "Sent" alone. */
  moved?: { stageName: string; fromStageId: string } | null;
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
  onAnswer,
  onUndo,
}: {
  asking: boolean;
  outcome: Outcome | null;
  align?: "start" | "end";
  onAnswer: (sent: boolean) => void;
  onUndo: () => void;
}) {
  const reduce = useReducedMotion();
  const from = reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.9 };
  const pill = {
    className: s.prompt,
    "data-align": align,
    initial: from,
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: from,
    transition: reduce ? { duration: 0.15 } : toMotion(SPRINGS.default),
  };
  return (
    <AnimatePresence mode="wait">
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
          <svg viewBox="0 0 16 16" width="14" height="14" className={s.tick} aria-hidden>
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
          <span className={s.said}>
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
          {outcome.moved && !outcome.undone && (
            <button type="button" className={s.undo} onClick={onUndo}>
              Undo
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
