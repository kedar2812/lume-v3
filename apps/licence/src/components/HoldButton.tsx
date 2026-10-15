"use client";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/**
 * Press and hold to confirm an irreversible action (owner, 2026-10-15: "a press to hold … button in red"). The fill
 * follows the hold; letting go early springs it back and nothing happens. Space or Enter held works the same. If
 * the action fails (`onDone` answers false), the button empties so it can be held again.
 */
export function HoldButton({
  ms = 1500,
  label,
  busyLabel,
  onDone,
  describedBy,
}: {
  ms?: number;
  label: string;
  busyLabel: string;
  onDone: () => Promise<boolean>;
  describedBy?: string;
}) {
  const [p, setP] = useState(0);
  const progress = useRef(0);
  const frame = useRef<number | null>(null);
  const done = useRef(false);
  const set = (v: number) => {
    progress.current = v;
    setP(v);
  };
  const stop = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  useEffect(() => stop, []);

  const finish = async () => {
    done.current = true;
    if (!(await onDone())) {
      done.current = false;
      set(0);
    }
  };
  const start = () => {
    if (done.current) return;
    stop();
    const from = progress.current;
    let t0: number | null = null;
    const tick = (now: number) => {
      t0 ??= now - from * ms;
      const k = Math.min(1, (now - t0) / ms);
      set(k);
      if (k >= 1) {
        frame.current = null;
        void finish();
        return;
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };
  const release = () => {
    stop();
    if (done.current || progress.current === 0) return;
    const from = progress.current;
    let t0: number | null = null;
    // Back to empty along an ease-out, from wherever the fill is.
    const back = (now: number) => {
      t0 ??= now;
      const k = Math.min(1, (now - t0) / 260);
      set(k >= 1 ? 0 : from * Math.pow(1 - k, 3));
      frame.current = k < 1 ? requestAnimationFrame(back) : null;
    };
    frame.current = requestAnimationFrame(back);
  };

  return (
    <button
      type="button"
      className="hold"
      aria-describedby={describedBy}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.repeat || (e.key !== " " && e.key !== "Enter")) return;
        e.preventDefault();
        start();
      }}
      onKeyUp={release}
      onBlur={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="fill" style={{ transform: `scaleX(${p})` }} aria-hidden />
      <span className={`lbl${p > 0.5 ? " lit" : ""}`}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="8.5" />
          <path d="M6 6l12 12" />
        </svg>
        {p > 0 ? busyLabel : label}
      </span>
    </button>
  );
}
