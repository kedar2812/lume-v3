"use client";
import { AiGlyph } from "@/components/ai/AiGlyph";
import s from "./builder.module.css";

/**
 * What LUME AI is building (plan 2026-11-23-flow-builder, Task C2; approved canvas, board Builder): its plan, the row
 * being built now, and once it's done what LUME changed on the way (`said`), until Keep or Discard.
 */
export function PlanCard({
  rows,
  at,
  done,
  said,
}: {
  rows: string[];
  /** The row being built now. */
  at: number;
  done: boolean;
  said: string | null;
}) {
  return (
    <section className={s.plan} aria-label="What LUME AI is building" aria-live="polite" data-tool>
      <h3 className={s.planHead}>
        <AiGlyph size={18} />
        {done ? "Built" : "LUME AI is building"}
        {rows.length > 0 && (
          <span>
            {done ? rows.length : Math.min(at + 1, rows.length)} of {rows.length}
          </span>
        )}
      </h3>
      <ol className={s.planRows}>
        {rows.map((t, i) => (
          <li key={i} data-state={done || i < at ? "done" : i === at ? "now" : undefined} title={t}>
            <span className={s.planTick}>
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="m3.5 8.5 3 3 6-7" />
              </svg>
            </span>
            <span className={s.planText}>{t}</span>
          </li>
        ))}
      </ol>
      {done && said && <p className={s.planSaid}>{said}</p>}
    </section>
  );
}
