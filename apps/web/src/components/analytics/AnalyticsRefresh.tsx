"use client";
import { useReducedMotion } from "motion/react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { RefreshMorph, Tick } from "@/components/ui/RefreshMorph";
import { usePhasedRefresh } from "@/components/ui/usePhasedRefresh";
import s from "@/components/ui/refresh.module.css";
import { analyticsClient } from "@/lib/analytics/client";

const Arrow = ({ spin }: { spin?: boolean }) => (
  <svg className={spin ? s.spin : undefined} viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path
      d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2.5v3h-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
/** The bars the card rebuilds: a little week of numbers, in the one blue. */
const BARS = [0.42, 0.66, 0.5, 0.86, 0.62, 0.95, 0.74];

/**
 * Analytics' Refresh (owner, 2026-10-05): the Refresh motion with its own card. The button lifts into the pill,
 * opens into a card where a week of bars rebuilds from the floor under a sweep of light while LUME recounts today,
 * yesterday and any day a change touched, then "✓ Up to date" and the boards read their numbers again. A second
 * press within a minute of the last count says when that was.
 */
export function AnalyticsRefresh({ onRecounted }: { onRecounted(): void }) {
  const reduce = !!useReducedMotion();
  const run = useCallback(async () => {
    const r = await analyticsClient.refresh();
    if (!r.ok) throw new Error(r.message);
    onRecounted();
    return r.data;
  }, [onRecounted]);
  const announce = useCallback(
    (d: { recounted: boolean }) =>
      d.recounted ? "Numbers recounted just now." : "Numbers were recounted a moment ago.",
    [],
  );
  const r = usePhasedRefresh({ reduce, run, announce });
  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState({ w: 96, h: 32 });
  useLayoutEffect(() => {
    if (btn.current) setBox({ w: btn.current.offsetWidth, h: btn.current.offsetHeight });
  }, [r.phase]);
  const warn = !!r.failure;
  const landed = warn ? "Try later" : "Up to date";

  return (
    <span className={s.anchor}>
      <Button
        ref={btn}
        aria-disabled={r.phase !== "idle" || undefined}
        title="Recount the numbers"
        className={s.button}
        data-phase={r.phase}
        onClick={() => void r.press()}
      >
        {r.phase === "landed" ? (
          <span className={s.landed} data-warn={warn || undefined}>
            {!warn && <Tick size={13} />}
            {landed}
          </span>
        ) : (
          <>
            <Arrow spin={r.phase !== "idle"} />
            Refresh
          </>
        )}
      </Button>
      <RefreshMorph
        phase={r.phase}
        box={box}
        reduce={reduce}
        warn={warn}
        pill={
          <>
            <img src="/lume-mark.png" alt="" width={20} height={20} />
            Recounting your numbers…
          </>
        }
        card={
          <>
            <div className={s.chart} data-flowing={!reduce || undefined} aria-hidden>
              {BARS.map((h, i) => (
                <span key={i} style={{ ["--h" as string]: `${h * 100}%`, ["--i" as string]: i }} />
              ))}
              <em />
            </div>
            <p className={s.title}>Recounting your numbers</p>
            <p className={s.sub}>Today, yesterday, and any day a change touched</p>
          </>
        }
        result={
          warn ? (
            <>
              <p className={s.resultTitle}>Couldn’t recount</p>
              <p className={s.sub}>{r.failure}</p>
            </>
          ) : (
            <>
              <p className={s.resultTitle}>Up to date</p>
              <p className={s.sub}>
                {r.result && !r.result.recounted
                  ? "Counted less than a minute ago."
                  : "Every number counted just now."}
              </p>
            </>
          )
        }
        face={
          <>
            <Tick size={13} />
            {landed}
          </>
        }
      />
      {r.said && (
        <p role="status" aria-live="polite" className={s.srOnly}>
          {r.said}
        </p>
      )}
    </span>
  );
}
