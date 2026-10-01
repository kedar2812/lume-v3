"use client";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { QueueView } from "@/lib/queues/client";
import s from "./run.module.css";

/** The end of a run: how it went (sent, not sent, skipped with why) and one action, Done. */
export function QueueSummary({
  q,
  finishedHere,
  onDone,
  onRetry,
}: {
  q: QueueView;
  /** Try a lead answered Not sent again (absent once the run was ended). */
  onRetry?: (position: number) => void;
  /** Finished in front of the person just now: the mark springs in (with the `cleared` sound, played by the run). */
  finishedHere: boolean;
  onDone: () => void;
}) {
  const reduce = useReducedMotion();
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => done.current?.focus(), []);
  const ended = q.status === "cancelled";
  const skipped = q.items.filter((i) => i.status === "skipped");
  const notSent = q.items.filter((i) => i.status === "not_sent");
  // Sent, but LUME couldn't log it on the lead (it went, and counts): said, so it isn't a surprise later.
  const unlogged = q.items.filter((i) => i.status === "sent" && i.reason?.startsWith("Sent, but not logged"));
  const spring = reduce ? { duration: 0.15 } : toMotion(SPRINGS.bounce);
  return (
    <motion.section
      className={s.summary}
      aria-label={ended ? "Run ended" : "Run finished"}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={spring}
    >
      {finishedHere && (
        <motion.img
          src="/lume-mark.png"
          alt=""
          width={52}
          height={52}
          initial={reduce ? false : { rotate: -120, opacity: 0 }}
          animate={{ rotate: 0, opacity: 1 }}
          transition={spring}
        />
      )}
      <h2 className={s.summaryTitle}>{ended ? "This run was ended" : "Run finished"}</h2>
      <p className={s.summaryLine}>
        <span className={s.num}>{q.done.sent} sent</span>
        {" · "}
        <span className={s.num}>{q.done.notSent} not sent</span>
        {" · "}
        <span className={s.num}>{q.done.skipped} skipped</span>
      </p>
      {skipped.length > 0 && (
        <ul aria-label="Skipped" className={s.skipped}>
          {skipped.map((i) => (
            <li key={i.position}>
              <span className={s.skipName}>{i.name}</span>
              <span className={s.skipWhy}>{i.reason === "Skipped" ? "You skipped" : i.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {unlogged.length > 0 && (
        <ul aria-label="Not logged" className={s.skipped}>
          {unlogged.map((i) => (
            <li key={i.position}>
              <span className={s.skipName}>{i.name}</span>
              <span className={s.skipWhy}>
                {i.reason!.replace(/^Sent, but not logged on the lead: /, "")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {notSent.length > 0 && onRetry && (
        <ul aria-label="Not sent" className={s.skipped}>
          {notSent.map((i) => (
            <li key={i.position}>
              <span className={s.skipName}>{i.name}</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Try ${i.name} again`}
                onClick={() => onRetry(i.position)}
              >
                Try again
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button ref={done} variant="primary" onClick={onDone}>
        Done
      </Button>
    </motion.section>
  );
}
