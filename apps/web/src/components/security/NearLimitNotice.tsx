"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
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
          <UI_ICONS.info size={ICON_SIZE.md} aria-hidden className={s.icon} />
          <span className={s.text}>
            <b>You’ve opened a lot of contacts this hour</b>
            <span>LUME tells your admins when activity looks unusual.</span>
          </span>
          <button type="button" className={s.dismiss} aria-label="Dismiss" onClick={() => setShow(false)}>
            <UI_ICONS.close size={ICON_SIZE.sm} aria-hidden />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
