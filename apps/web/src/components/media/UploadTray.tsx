"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { bytesText } from "@lume/core/shared";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { Upload } from "./useUploads";
import s from "./media.module.css";

const R = 9;
const C = 2 * Math.PI * R;

/** One file's state as a small mark: a ring filling, a tick, or a cross. */
function Mark({ u }: { u: Upload }) {
  if (u.state === "refused")
    return (
      <span className={s.mark} data-state="refused" aria-hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M8 8l8 8M16 8l-8 8" />
        </svg>
      </span>
    );
  if (u.state === "added")
    return (
      <span className={s.mark} data-state="added" aria-hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path className={s.tick} d="m6 12.5 4 4 8-9" />
        </svg>
      </span>
    );
  return (
    <span className={s.mark} aria-hidden>
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r={R} fill="none" strokeWidth="2.6" stroke="var(--line-2)" />
        <circle
          cx="12"
          cy="12"
          r={R}
          fill="none"
          strokeWidth="2.6"
          stroke="var(--accent)"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - u.share)}
          transform="rotate(-90 12 12)"
          style={{ transition: "stroke-dashoffset 0.4s var(--spring-soft)" }}
        />
      </svg>
    </span>
  );
}

function status(u: Upload) {
  if (u.state === "refused") return u.problem;
  if (u.state === "added") return "Added";
  if (u.state === "waiting") return "Waiting its turn";
  return `Uploading · ${bytesText(u.size * u.share)} of ${bytesText(u.size)}`;
}

/**
 * Files on their way in (canvas Drop): each with its progress, Added with a tick, or LUME's reason it wasn't. It
 * leaves once everything is in; a refusal stays until it's dismissed, so it's read.
 */
export function UploadTray({ uploads, onDismiss }: { uploads: Upload[]; onDismiss(key: string): void }) {
  const reduce = !!useReducedMotion();
  const going = uploads.filter((u) => u.state !== "added" && u.state !== "refused").length;
  return (
    <AnimatePresence>
      {uploads.length > 0 && (
        <motion.section
          className={s.tray}
          aria-label="Adding files"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
          transition={toMotion(SPRINGS.drawer)}
        >
          <b className={s.trayTitle} aria-live="polite">
            {going ? `Adding ${going} ${going === 1 ? "file" : "files"}` : "Done"}
          </b>
          <ul>
            <AnimatePresence initial={false}>
              {uploads.map((u) => (
                <motion.li
                  key={u.key}
                  layout={reduce ? false : "position"}
                  className={s.up}
                  data-state={u.state}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0 }}
                  transition={toMotion(SPRINGS.default)}
                >
                  <Mark u={u} />
                  <span className={s.upText}>
                    <span className={s.upName}>{u.name}</span>
                    <span className={s.upStatus} role={u.state === "refused" ? "alert" : undefined}>
                      {status(u)}
                    </span>
                  </span>
                  {u.state === "refused" && (
                    <button
                      type="button"
                      className={s.dismiss}
                      aria-label={`Dismiss ${u.name}`}
                      onClick={() => onDismiss(u.key)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                        <path d="M7 7l10 10M17 7 7 17" />
                      </svg>
                    </button>
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
