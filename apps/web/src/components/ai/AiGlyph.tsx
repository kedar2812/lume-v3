"use client";
import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";

/** The Loop's one stroke, as in the master file. */
const LOOP = "M16 84 C 34 84, 52 72, 60 52 C 70 28, 64 10, 51 12 C 38 14, 36 36, 43 57 C 50 77, 66 86, 82 79";

/**
 * LUME AI's mark, The Loop (owner, 2026-10-18): one handwritten stroke, an l for LUME, that curls back on itself —
 * LUME AI never lets a lead go quiet. The master file is /public/lume-ai-mark.svg; this draws the same path.
 */
export function AiGlyph({
  size = 16,
  className,
  draw,
  tone,
}: {
  size?: number;
  className?: string;
  /**
   * Draw the stroke: `once` (a run starting), `pen` again and again while LUME AI writes (Autopilot §1.4, §2), or `loop`:
   * LUME AI's own mark in the sidebar (owner, 2026-10-27), whole for 3 s, fading a moment, then drawn again in 2.4 s.
   * Calm, never busy, and whole on its first frame, so it never shows as an empty stroke (2026-10-28).
   */
  draw?: "once" | "pen" | "loop";
  /** `muted`: grey, and slower, for LUME AI switched off (plan 2026-10-28, artboard 5). */
  tone?: "muted";
}) {
  // One gradient per drawing: two marks on a page never share (or lose) each other's.
  const id = `lume-ai-loop-${useId().replace(/:/g, "")}`;
  // Reduced motion: the mark rests, fully drawn.
  const moving = useReducedMotion() ? undefined : draw;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#1e47d9" />
          <stop offset=".55" stopColor="#2a5bff" />
          <stop offset="1" stopColor="#5ab8ff" />
        </linearGradient>
      </defs>
      <motion.path
        // A mark that stops moving (reduced motion, known only after the first frame) is drawn afresh, whole: one
        // left where its animation was would be a dot (2026-10-28).
        key={moving ?? "still"}
        d={LOOP}
        fill="none"
        stroke={tone === "muted" ? "var(--text-3)" : `url(#${id})`}
        {...(tone ? { "data-tone": tone } : {})}
        strokeWidth="11"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...(moving ? { "data-draw": draw } : {})}
        {...(moving === "once"
          ? {
              initial: { pathLength: 0 },
              animate: { pathLength: 1 },
              transition: { duration: 0.7, ease: "easeInOut" },
            }
          : moving === "pen"
            ? {
                initial: { pathLength: 0 },
                animate: { pathLength: [0, 1, 1], opacity: [1, 1, 0.35] },
                transition: { duration: 2.4, times: [0, 0.7, 1], ease: "easeInOut", repeat: Infinity },
              }
            : moving === "loop"
              ? {
                  initial: { pathLength: 1, opacity: 1 },
                  animate: { pathLength: [1, 1, 1, 0, 1], opacity: [1, 1, 0.15, 1, 1] },
                  transition: {
                    duration: tone === "muted" ? 8 : 6,
                    times: [0, 0.5, 0.58, 0.6, 1],
                    ease: "easeInOut",
                    repeat: Infinity,
                  },
                }
              : {})}
      />
    </svg>
  );
}
