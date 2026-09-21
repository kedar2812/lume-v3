"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { SoundCue } from "@/lib/sound";
import { useSound } from "./SoundProvider";
import s from "./Toast.module.css";

type Tone = "ok" | "accent" | "warn" | "danger" | "wa" | "meet";
export type ToastInput = {
  tone?: Tone;
  title: string;
  detail?: string;
  action?: { label: string; onClick(): void };
  sound?: SoundCue;
  durationMs?: number;
};
type Item = ToastInput & { id: string };
type Api = { toast(t: ToastInput): string; dismiss(id: string): void };

const ToastContext = createContext<Api>({ toast: () => "", dismiss: () => undefined });
const TONE_BG: Record<Tone, string> = {
  ok: "var(--ok)",
  accent: "var(--accent)",
  warn: "var(--warn)",
  danger: "var(--danger)",
  wa: "var(--wa)",
  meet: "var(--meet)",
};
const PATH: Record<Tone, string> = {
  ok: "M3 7.5 6 10.3 11.5 4",
  wa: "M3 7.5 6 10.3 11.5 4",
  accent: "M7 3.5V7l2.5 1.5",
  meet: "M7 3.5V7l2.5 1.5",
  warn: "M7 3.5v4M7 10.2v.1",
  danger: "M4 4l6 6M10 4l-6 6",
};
const MAX = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);
  const { play } = useSound();
  const reduce = useReducedMotion();

  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const arm = useCallback(
    (id: string, ms: number) => {
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms),
      );
    },
    [dismiss],
  );

  const toast = useCallback(
    (t: ToastInput) => {
      const id = `t${++seq.current}`;
      setItems((xs) => [...xs, { ...t, id }].slice(-MAX));
      arm(id, t.durationMs ?? 4200);
      if (t.sound) play(t.sound);
      return id;
    },
    [arm, play],
  );

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={s.region} role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => {
            const tone = t.tone ?? "ok";
            const ms = t.durationMs ?? 4200;
            return (
              <motion.div
                key={t.id}
                layout
                className={s.toast}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.94, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                exit={
                  reduce
                    ? { opacity: 0 }
                    : { opacity: 0, y: 14, scale: 0.96, transition: { duration: 0.2, ease: "easeIn" } }
                }
                transition={toMotion(SPRINGS.bounce)}
                onMouseEnter={() => clearTimeout(timers.current.get(t.id))}
                onMouseLeave={() => arm(t.id, 1600)}
              >
                <span className={s.icon} style={{ background: TONE_BG[tone] }}>
                  <svg viewBox="0 0 14 14" aria-hidden>
                    <path d={PATH[tone]} />
                  </svg>
                </span>
                <span className={s.text}>
                  <span className={s.title}>{t.title}</span>
                  {t.detail && <span className={s.detail}>{t.detail}</span>}
                </span>
                {t.action && (
                  <button
                    type="button"
                    className={s.action}
                    onClick={() => {
                      t.action!.onClick();
                      dismiss(t.id);
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
                <motion.i
                  className={s.timer}
                  initial={{ scaleX: 1 }}
                  animate={{ scaleX: 0 }}
                  transition={{ duration: ms / 1000, ease: "linear" }}
                />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
