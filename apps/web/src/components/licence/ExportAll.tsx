"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { EXPORT_URL } from "@/lib/licence/client";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./licence.module.css";

/** What the zip holds, in the order it's written (the API's export). */
const FILES = ["Leads.csv", "Notes.csv", "Activity.csv", "Follow-ups.csv", "Users.csv", "LUME-export.xlsx"];
const TICK_MS = 380;

type Phase =
  | { kind: "idle" }
  | { kind: "working"; ticked: number }
  | { kind: "ready"; url: string; name: string }
  | { kind: "failed"; message: string };

/**
 * Export all data (spec §3.6), in every licence state. "detailed" (the lock screen, as the canvas draws it)
 * ticks through the files and offers the zip; the compact kinds (the read-only bar, Settings → About) show
 * a spinner and then Download.
 */
export function ExportAll({ variant = "secondary" }: { variant?: "primary" | "secondary" | "bar" }) {
  const detailed = variant === "primary";
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  const url = useRef<string | null>(null);
  useEffect(
    () => () => {
      clearInterval(timer.current);
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

  const ticks = useRef(0);
  const start = async () => {
    ticks.current = 0;
    setPhase({ kind: "working", ticked: 0 });
    // The files tick through while the zip arrives; the last waits for it.
    timer.current = setInterval(
      () => {
        if (ticks.current >= FILES.length - 1) return;
        ticks.current += 1;
        setPhase({ kind: "working", ticked: ticks.current });
      },
      reduce ? 60 : TICK_MS,
    );
    try {
      const r = await fetch(EXPORT_URL, { credentials: "same-origin" });
      if (!r.ok)
        throw new Error(
          r.status === 403
            ? "Exporting everything isn't part of your role."
            : "The export didn't finish. Try again.",
        );
      const blob = await r.blob();
      const name =
        /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "LUME-export.zip";
      url.current = URL.createObjectURL(blob);
      // Let the files finish ticking before the zip is offered.
      await new Promise<void>((done) => {
        const wait = setInterval(() => {
          if (ticks.current < FILES.length - 1) return;
          clearInterval(wait);
          done();
        }, 50);
      });
      clearInterval(timer.current);
      setPhase({ kind: "ready", url: url.current, name });
    } catch (e) {
      clearInterval(timer.current);
      setPhase({ kind: "failed", message: (e as Error).message });
    }
  };

  const btnClass = variant === "primary" ? s.btnPrimary : variant === "bar" ? s.btnOnBlue : s.btnSecondary;
  if (!detailed) {
    if (phase.kind === "ready")
      return (
        <a className={btnClass} href={phase.url} download={phase.name}>
          Download
        </a>
      );
    return (
      <button
        type="button"
        className={btnClass}
        onClick={() => void start()}
        disabled={phase.kind === "working"}
      >
        {phase.kind === "working"
          ? "Exporting…"
          : phase.kind === "failed"
            ? "Try the export again"
            : "Export all data"}
      </button>
    );
  }

  const ticked = phase.kind === "working" ? phase.ticked : phase.kind === "ready" ? FILES.length : 0;
  return (
    <div className={s.exportBox}>
      {phase.kind === "idle" || phase.kind === "failed" ? (
        <>
          <button type="button" className={btnClass} onClick={() => void start()}>
            Export all data
          </button>
          {phase.kind === "failed" && (
            <p role="alert" className={s.exportError}>
              {phase.message}
            </p>
          )}
        </>
      ) : (
        <>
          <span className={s.exportBar} aria-hidden>
            <span style={{ transform: `scaleX(${ticked / FILES.length})` }} />
          </span>
          <ul aria-label="Export" className={s.exportFiles}>
            {FILES.map((f, i) => (
              <li key={f} data-done={i < ticked || undefined}>
                <span className={s.fileMark} aria-hidden>
                  {i < ticked && (
                    <motion.svg
                      viewBox="0 0 10 10"
                      width="9"
                      height="9"
                      initial={reduce ? false : { scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={toMotion(SPRINGS.bounce)}
                    >
                      <path
                        d="M2 5.2l2 2 4-4.5"
                        fill="none"
                        stroke="#fff"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </motion.svg>
                  )}
                </span>
                {f}
              </li>
            ))}
          </ul>
          <AnimatePresence>
            {phase.kind === "ready" && (
              <motion.div
                className={s.exportReady}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={reduce ? { duration: 0.15 } : toMotion(SPRINGS.default)}
              >
                <span className={s.exportName}>
                  <strong>{phase.name}</strong> is ready
                </span>
                <a className={s.btnDownload} href={phase.url} download={phase.name}>
                  Download
                </a>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
