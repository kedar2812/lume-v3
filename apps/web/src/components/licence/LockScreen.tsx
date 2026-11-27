"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { licenceClient } from "@/lib/licence/client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { ExportAll } from "./ExportAll";
import { KeyRow } from "./KeyRow";
import { useLicence } from "./LicenceProvider";
import s from "./licence.module.css";

/**
 * Suspended (canvas: States): the app blurs behind a card that says LUME is paused. The padlock's shackle
 * drops shut; an admin can still Export all data. Nothing behind it can be reached.
 */
export function LockScreen() {
  const { licence, canExport, set } = useLicence();
  const [checking, setChecking] = useState(false);
  /** What the last Check again found: still paused, or that it couldn't ask at all. */
  const [said, setSaid] = useState<"" | "still" | "unreached">("");
  const reduce = useReducedMotion();
  const card = useRef<HTMLDivElement>(null);
  const on = licence.state === "suspended";
  useEffect(() => {
    if (on) card.current?.focus();
  }, [on]);
  return (
    <AnimatePresence>
      {on && (
        <motion.div
          key="lock"
          className={s.lockScrim}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0.15 : 0.45 }}
        >
          <motion.div
            ref={card}
            tabIndex={-1}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="lume-paused-title"
            aria-describedby="lume-paused-words"
            className={s.lockCard}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={reduce ? { duration: 0.15 } : { ...toMotion(SPRINGS.default), delay: 0.08 }}
          >
            <span className={s.padlock} aria-hidden>
              <UI_ICONS.private size={ICON_SIZE.lg} aria-hidden />
            </span>
            <h2 id="lume-paused-title" className={s.lockTitle}>
              LUME is paused
            </h2>
            <p id="lume-paused-words" className={s.lockWords}>
              Your leads, notes and history are safe on your own server. An admin can export everything, any
              time.
            </p>
            {canExport && <ExportAll variant="primary" />}
            <p className={s.lockFoot}>To carry on, contact whoever licensed LUME to you.</p>
            {/* The owner puts it right with the new key they were sent (spec 2026-10-15 §2.4: Issue a new key). */}
            {licence.key?.canChange && (
              <div className={s.lockKey}>
                <KeyRow licence={licence} onChanged={set} cta="Enter a new product key" />
              </div>
            )}
            {/* Once the pause is lifted, an admin needn't wait for the next check (every 6 hours). */}
            {licence.canCheck && (
              <p className={s.lockAgain} aria-live="polite">
                {said === "still" && <span>Still paused. LUME checked just now.</span>}
                {said === "unreached" && (
                  <span>LUME couldn&apos;t reach its licence server just now. Try again in a minute.</span>
                )}
                <button
                  type="button"
                  className={s.lockAgainBtn}
                  disabled={checking}
                  onClick={async () => {
                    setChecking(true);
                    setSaid("");
                    const r = await licenceClient.check();
                    setChecking(false);
                    // No answer, or an answer without a fresh check: say so, never "checked just now".
                    if (!r.ok || r.data.lastError) return setSaid("unreached");
                    set(r.data);
                    setSaid(r.data.state === "suspended" ? "still" : "");
                  }}
                >
                  {checking ? "Checking…" : "Check again"}
                </button>
              </p>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
