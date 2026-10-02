"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import { onNearLimit, takeNearLimit } from "@/lib/security/near-limit";
import s from "./notice.module.css";

/** One calm, dismissible line (canvas [RepView]), shown once an hour when a person nears a limit. */
export function NearLimitNotice() {
  const reduce = useReducedMotion();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (takeNearLimit()) setShow(true);
    return onNearLimit(() => {
      if (takeNearLimit()) setShow(true);
    });
  }, []);
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          role="note"
          className={s.notice}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={toMotion(SPRINGS.default)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden className={s.icon}>
            <circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 7.2v3.6M8 5.1v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span className={s.text}>
            <b>You’ve opened a lot of contacts this hour</b>
            <span>LUME tells your admins when activity looks unusual.</span>
          </span>
          <button type="button" className={s.dismiss} aria-label="Dismiss" onClick={() => setShow(false)}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
