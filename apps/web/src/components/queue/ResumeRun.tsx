"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import { QUEUE_CHANGED, doneOf, queuesClient, type QueueView } from "@/lib/queues/client";
import s from "./queue.module.css";

/**
 * A run left open (4C): picked up again from the top bar (a quiet pill) or Today (a card that says where
 * it came from and why it's paused). It looks again whenever a run starts, pauses or ends.
 */
export function ResumeRun({ variant }: { variant: "pill" | "card" }) {
  const reduce = useReducedMotion();
  const [run, setRun] = useState<QueueView | null>(null);
  const look = useCallback(async () => {
    const r = await queuesClient.current();
    if (r.ok) setRun(r.data);
  }, []);
  useEffect(() => {
    void look();
    const again = () => void look();
    window.addEventListener(QUEUE_CHANGED, again);
    return () => window.removeEventListener(QUEUE_CHANGED, again);
  }, [look]);

  const label = run ? `Resume · ${doneOf(run)} of ${run.total}` : "";
  const progress = run && run.total ? doneOf(run) / run.total : 0;
  const capped = run?.status === "paused" && run.pausedReason === "daily_cap";
  return (
    <AnimatePresence initial={false}>
      {run &&
        (variant === "pill" ? (
          <motion.span
            key="pill"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
            transition={toMotion(SPRINGS.default)}
            className={s.pillWrap}
          >
            <Link href={`/queue/${run.id}`} className={s.pill} title={run.sourceName}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className={s.pillRing}>
                <circle cx="8" cy="8" r="6" className={s.ringTrack} />
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  className={s.ringFill}
                  pathLength={1}
                  strokeDasharray={`${progress} 1`}
                  transform="rotate(-90 8 8)"
                />
              </svg>
              {label}
            </Link>
          </motion.span>
        ) : (
          <motion.section
            key="card"
            aria-label="Your send queue"
            className={s.resumeCard}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={toMotion(SPRINGS.default)}
          >
            <div className={s.resumeText}>
              <p className={s.resumeTitle}>
                {run.status === "paused" ? "Your send queue is paused" : "Your send queue is open"}
              </p>
              <p className={s.resumeLine}>
                {run.sourceName}
                {run.templateName ? ` · ${run.templateName}` : ""}
                {capped ? ` · Paused until tomorrow: today's ${run.today.cap} are sent` : ""}
              </p>
              <span className={s.resumeBar} aria-hidden>
                <span style={{ transform: `scaleX(${progress})` }} />
              </span>
            </div>
            <Link href={`/queue/${run.id}`} className={s.resumeBtn}>
              {label}
            </Link>
          </motion.section>
        ))}
    </AnimatePresence>
  );
}
