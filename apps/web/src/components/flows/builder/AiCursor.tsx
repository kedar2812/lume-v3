"use client";
import { ViewportPortal } from "@xyflow/react";
import { useId } from "react";
import { LOOP } from "@/components/ai/AiGlyph";
import s from "./builder.module.css";

/**
 * LUME AI's cursor (plan 2026-11-23-flow-builder, Task C2; approved canvas, board Builder): on the step it's placing,
 * in the canvas's own coordinates, so it stays on the step when the canvas moves; drawn at the size it has on screen
 * whatever the zoom. Its move is the beat: each step lands as it arrives.
 */
export function AiCursor({ x, y, label, zoom }: { x: number; y: number; label: string; zoom: number }) {
  const id = `ai-cursor-${useId().replace(/:/g, "")}`;
  return (
    <ViewportPortal>
      <div
        data-ai-cursor=""
        className={s.cursor}
        style={{ transform: `translate(${x}px, ${y}px)` }}
        aria-hidden
      >
        <div className={s.cursorScale} style={{ transform: `scale(${1 / Math.max(zoom, 0.05)})` }}>
          <svg className={s.cursorPtr} viewBox="0 0 20 22">
            <defs>
              <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#5ab8ff" />
                <stop offset="1" stopColor="#1e47d9" />
              </linearGradient>
            </defs>
            <path
              d="M2 1.5 18 10l-7 1.6-3.4 6.4z"
              fill={`url(#${id})`}
              stroke="#fff"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          <span className={s.cursorLabel}>
            <svg viewBox="0 0 100 100" aria-hidden>
              <path
                d={LOOP}
                fill="none"
                stroke="#fff"
                strokeWidth="12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {label}
          </span>
        </div>
      </div>
    </ViewportPortal>
  );
}
