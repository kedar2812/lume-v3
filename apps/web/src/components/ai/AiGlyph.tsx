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
}: {
  size?: number;
  className?: string;
  /** Draw the stroke: `once` (a run starting), or `pen`, again and again while LUME AI works (Autopilot §1.4, §2). */
  draw?: "once" | "pen";
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
        d={LOOP}
        fill="none"
        stroke={`url(#${id})`}
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
            : {})}
      />
    </svg>
  );
}
