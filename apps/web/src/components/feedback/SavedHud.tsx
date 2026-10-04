"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect } from "react";
import { BodyPortal } from "@/components/ui/BodyPortal";
import s from "./saved-hud.module.css";

const SHOWN_MS = 1500;

/**
 * "Saved", said once in the middle of the screen (owner, 2026-10-05): a frosted square rises in, its check draws
 * itself, and it fades away on its own. It never takes focus or blocks a click; screen readers hear it politely.
 * Reduce Motion gets a plain fade. Silent: saving isn't an achievement (sound policy).
 */
export function SavedHud({
  shown,
  title,
  detail,
  onDone,
}: {
  shown: boolean;
  title: string;
  detail?: string;
  onDone(): void;
}) {
  const reduce = !!useReducedMotion();
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(onDone, SHOWN_MS);
    return () => clearTimeout(t);
  }, [shown, onDone]);
  return (
    <BodyPortal>
      {shown && (
        <div className={s.live} role="status" aria-live="polite">
          {`${title}${detail ? `. ${detail}` : ""}`}
        </div>
      )}
      <AnimatePresence>
        {shown && (
          <motion.div
            className={s.hud}
            aria-hidden
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.86, filter: "blur(8px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, filter: "blur(6px)" }}
            transition={reduce ? { duration: 0.2 } : { type: "spring", bounce: 0.25, duration: 0.45 }}
          >
            <svg viewBox="0 0 48 48" width="52" height="52" className={s.check}>
              <circle cx="24" cy="24" r="21" className={s.ring} />
              <motion.path
                d="M15 24.5l6.2 6.2L33.5 18"
                className={s.tick}
                initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{
                  delay: reduce ? 0 : 0.12,
                  duration: reduce ? 0 : 0.36,
                  ease: [0.65, 0, 0.35, 1],
                }}
              />
            </svg>
            <p className={s.title}>{title}</p>
            {detail && <p className={s.detail}>{detail}</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </BodyPortal>
  );
}
