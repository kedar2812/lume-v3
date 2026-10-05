"use client";
import type { CSSProperties, ReactNode } from "react";
import type { Trend } from "@lume/core/shared";
import { areaUnder, smooth, sparkLine, toPts } from "@/lib/analytics/chart";
import s from "./analytics.module.css";

const ARROWS = {
  up: "M1.5 11.5 6 7l3 3 5.5-5.5M10.5 4.5h4v4",
  down: "M1.5 4.5 6 9l3-3 5.5 5.5M10.5 11.5h4v-4",
  flat: "M2 8h12",
};

/** The owner's trend rule, drawn: the arrow follows the direction, the colour follows good or bad, the sign is always there. */
export function Chip({ trend, off }: { trend: Trend | null; off?: string }) {
  if (!trend)
    return off ? (
      <span className={s.chip} data-tone="flat">
        {off}
      </span>
    ) : null;
  return (
    <span className={s.chip} data-tone={trend.tone}>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d={ARROWS[trend.dir]} />
      </svg>
      {trend.text}
    </span>
  );
}

export function Card({
  title,
  sub,
  right,
  i = 0,
  children,
  label,
}: {
  title: string;
  sub?: string;
  right?: ReactNode;
  i?: number;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section className={s.card} style={{ "--i": i } as CSSProperties} aria-label={label ?? title}>
      <div className={s.cardHead}>
        <div>
          <h3>{title}</h3>
          {sub && <div className={s.sub}>{sub}</div>}
        </div>
        {right && <div>{right}</div>}
      </div>
      {children}
    </section>
  );
}

/** The little line in a tile's corner: the period's own days, not a made-up shape. */
export function Spark({ values }: { values: (number | null)[] }) {
  const line = sparkLine(values);
  if (!line || line.every((v) => v === 0)) return null;
  // The line sits in the tile's lower part: its low is near the bottom, its high below the number.
  const lo = Math.min(...line);
  const hi = Math.max(...line);
  const span = hi - lo || 1;
  const pts = toPts(
    line.map((v) => v - lo + span * 0.15),
    120,
    44,
    span * 1.25,
    2,
  );
  return (
    <svg className={s.spark} viewBox="0 0 120 44" preserveAspectRatio="none" aria-hidden>
      <path d={areaUnder(pts, 44)} />
      <path d={smooth(pts)} />
    </svg>
  );
}

export function Skeleton({ h, i = 0 }: { h: number; i?: number }) {
  return <div className={s.skel} style={{ height: h, animationDelay: `${i * 60}ms` }} aria-hidden />;
}

export const Ico = {
  go: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  ),
  clock: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  stuck: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  ),
  user: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0 1 12 0v1" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  ),
  globe: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  ),
  close: (
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
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
  chevron: (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  ),
  calendar: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  ),
};
