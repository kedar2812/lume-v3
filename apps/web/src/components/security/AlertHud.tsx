"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { NotificationView } from "@/lib/notifications/client";
import { useStream } from "@/lib/notifications/stream";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./hud.module.css";

const SHOWN_KEY = "lume.security.hud";
const STAYS_MS = 7000;

function seen(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(SHOWN_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function remember(id: string) {
  try {
    sessionStorage.setItem(SHOWN_KEY, JSON.stringify([...seen(), id].slice(-50)));
  } catch {
    // Private mode: it may show again after a reload, which is fine.
  }
}

/**
 * A security alert, arriving live (6A, canvas [Main]): a dark capsule rises once from the bottom, says what LUME
 * did, and offers Review. It stays 7 seconds, waits while it's hovered or focused, and never comes back for the
 * same alert. Silent: alerts aren't achievements. Mounted only for people who manage security.
 */
export function AlertHud() {
  const router = useRouter();
  const reduce = useReducedMotion();
  const [note, setNote] = useState<NotificationView | null>(null);
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useStream((n) => {
    if (n.kind !== "security_alert" || !n.alertId || seen().includes(n.alertId)) return;
    remember(n.alertId);
    setNote(n);
  });
  useEffect(() => {
    if (!note || held) return;
    timer.current = setTimeout(() => setNote(null), STAYS_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [note, held]);

  return (
    <AnimatePresence>
      {note && (
        <motion.div
          role="status"
          className={s.hud}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 28, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 20 }}
          transition={toMotion(SPRINGS.drawer)}
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
        >
          <span className={s.icon} aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M12 3 5 6v5.5c0 4.2 2.9 7.9 7 9.5 4.1-1.6 7-5.3 7-9.5V6l-7-3Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path d="M12 8v4.5M12 15.6v.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <span className={s.text}>
            <span className={s.title}>{note.title}</span>
            {note.body && <span className={s.body}>{note.body}</span>}
          </span>
          <button
            type="button"
            className={s.review}
            onClick={() => {
              router.push(`/settings/security?alert=${note.alertId}`);
              setNote(null);
            }}
          >
            Review
          </button>
          <button type="button" className={s.dismiss} aria-label="Dismiss" onClick={() => setNote(null)}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          {!reduce && <span className={s.bar} data-held={held || undefined} aria-hidden />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
