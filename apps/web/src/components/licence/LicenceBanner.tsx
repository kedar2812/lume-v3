"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import { licenceClient, type LicenceForPerson } from "@/lib/licence/client";
import { ExportAll } from "./ExportAll";
import { day, sinceWords, useLicence } from "./LicenceProvider";
import s from "./licence.module.css";

/** Why an admin is seeing grace, in LUME's words (spec §3.5). */
function graceWords(l: LicenceForPerson): { lead: string; rest: string } {
  const tail = "Only admins see this.";
  if (l.reason === "unreachable" && l.checkedAt)
    return {
      lead: `LUME couldn't reach its licence server for ${sinceWords(l.checkedAt)}.`,
      rest: `Everything works as usual and LUME keeps trying. ${tail}`,
    };
  if (l.reason === "not_checked")
    return {
      lead: "LUME hasn't reached its licence server yet.",
      rest: `Everything works as usual and LUME keeps trying. ${tail}`,
    };
  if (l.reason === "overdue")
    return {
      lead: "The licence payment is late.",
      rest: `Everything works as usual${l.graceEndsAt ? ` until ${day(l.graceEndsAt)}` : ""}. ${tail}`,
    };
  return { lead: "The licence needs attention.", rest: `Everything works as usual for now. ${tail}` };
}

/**
 * The strip across the top of the app (canvas: States): grace in amber, for admins only, with Check now;
 * read-only in the accent blue, for everyone, with Export all data for those who may. It comes down from
 * the top edge and goes back up it.
 */
export function LicenceBanner() {
  const { licence, canExport, set } = useLicence();
  const reduce = useReducedMotion();
  const [checking, setChecking] = useState(false);
  const grace = licence.state === "grace" && licence.canCheck;
  const readOnly = licence.state === "read_only";
  const motionProps = {
    initial: reduce ? { opacity: 0 } : { y: "-100%", opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: reduce ? { opacity: 0 } : { y: "-100%", opacity: 0 },
    transition: reduce ? { duration: 0.15 } : toMotion(SPRINGS.default),
  };
  const check = async () => {
    setChecking(true);
    const r = await licenceClient.check();
    setChecking(false);
    if (r.ok) set(r.data);
  };
  const words = grace ? graceWords(licence) : null;
  return (
    <div className={s.bannerSlot}>
      <AnimatePresence initial={false}>
        {words && (
          <motion.div key="grace" role="status" data-tone="grace" className={s.banner} {...motionProps}>
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden className={s.bannerIcon}>
              <path
                d="M9 2l7.5 13h-15z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <path d="M9 7.5v3.5M9 13.4v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span className={s.bannerText}>
              <strong>{words.lead}</strong> {words.rest}
            </span>
            <button type="button" className={s.bannerBtn} onClick={() => void check()} disabled={checking}>
              {checking ? "Checking…" : "Check now"}
            </button>
          </motion.div>
        )}
        {readOnly && (
          <motion.div
            key="read_only"
            role="status"
            data-tone="read_only"
            className={s.banner}
            {...motionProps}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden className={s.bannerIcon}>
              <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M8 4.8V8.4M8 11v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span className={s.bannerText}>
              <strong>Read-only.</strong> The licence needs attention: everyone can look and export, and
              changes wait until it&apos;s sorted.
            </span>
            {canExport && <ExportAll variant="bar" />}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
