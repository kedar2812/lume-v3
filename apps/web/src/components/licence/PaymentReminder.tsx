"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { licenceClient } from "@/lib/licence/client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { day, useLicence } from "./LicenceProvider";
import s from "./licence.module.css";

/**
 * The payment reminder (canvas: PaymentReminder): owners and admins, at every sign-in until it's paid. The
 * bell rings once as it rises. "I'll sort it" closes it for this session; the next sign-in shows it again.
 */
export function PaymentReminder({ businessName }: { businessName: string }) {
  const { licence, set } = useLicence();
  const reduce = useReducedMotion();
  const [closed, setClosed] = useState<string | null>(null);
  const later = useRef<HTMLButtonElement>(null);
  const n = licence.notice;
  const on = !!n && licence.showNotice && closed !== n.id;
  useEffect(() => {
    if (on) later.current?.focus();
  }, [on]);

  const sortIt = async () => {
    if (!n) return;
    setClosed(n.id);
    await licenceClient.dismiss();
    set({ ...licence, showNotice: false });
  };
  useEffect(() => {
    if (!on) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") void sortIt();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  return (
    <AnimatePresence>
      {on && n && (
        <motion.div
          key="reminder"
          className={s.reminderScrim}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0.15 : 0.4 }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="lume-due-title"
            className={s.reminder}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 22, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
            transition={reduce ? { duration: 0.15 } : { ...toMotion(SPRINGS.default), delay: 0.1 }}
          >
            <div className={s.reminderHead}>
              <span className={s.bellTile} aria-hidden>
                <motion.svg
                  viewBox="0 0 30 30"
                  width="30"
                  height="30"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transformOrigin: "50% 12%" }}
                  initial={false}
                  animate={reduce ? {} : { rotate: [0, 16, -12, 7, -3, 0] }}
                  transition={{ duration: 1.1, delay: 0.55 }}
                >
                  <path d="M8 20V13a7 7 0 0114 0v7l2 2.5H6z" />
                  <path d="M12.5 25.5a2.7 2.7 0 005 0" />
                </motion.svg>
              </span>
              <h2 id="lume-due-title" className={s.reminderTitle}>
                Your LUME payment is due
              </h2>
              <p className={s.reminderWords}>
                The licence for {businessName}{" "}
                {n.dueDate ? (
                  <>
                    was due on <strong>{day(n.dueDate)}</strong>.
                  </>
                ) : (
                  "is due."
                )}{" "}
                Everything keeps working while it&apos;s sorted.
              </p>
            </div>
            {n.note && (
              <div className={s.reminderNote}>
                <span className={s.noteHead}>A note from your LUME provider</span>
                <span>{n.note}</span>
              </div>
            )}
            <div className={s.reminderActions} data-single={!n.contact || undefined}>
              <button ref={later} type="button" className={s.btnSecondary} onClick={() => void sortIt()}>
                I&apos;ll sort it
              </button>
              {n.contact && (
                <a
                  className={s.btnPrimary}
                  href={n.contact}
                  target={n.contact.startsWith("https:") ? "_blank" : undefined}
                  rel="noreferrer"
                >
                  Contact about payment
                </a>
              )}
            </div>
            <p className={s.reminderFoot}>Shown to owners and admins at each sign-in until it&apos;s paid.</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
