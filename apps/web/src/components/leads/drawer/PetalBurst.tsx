"use client";
import { useEffect, useRef } from "react";
import s from "./drawer.module.css";

const COLORS = ["#2A5BFF", "#16B5FF", "#18A566", "#6E56CF", "#F2A20C", "#2A5BFF"];

/**
 * Six petals — the LUME mark — burst from where a lead was won. Decoration for an achievement only;
 * skipped entirely when the person prefers less motion.
 */
export function PetalBurst({ at, onDone }: { at: { x: number; y: number }; onDone: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const petals = [...(root.current?.children ?? [])] as HTMLElement[];
    if (reduce || !petals.length || typeof petals[0]!.animate !== "function") {
      onDone();
      return;
    }
    const runs = petals.map((p, i) => {
      const angle = (i / petals.length) * Math.PI * 2 - Math.PI / 2;
      const dist = 46 + (i % 2) * 10;
      const x = Math.cos(angle) * dist;
      const y = Math.sin(angle) * dist;
      const turn = (angle * 180) / Math.PI + 90;
      return p.animate(
        [
          { transform: `translate(0, 0) rotate(${turn}deg) scale(0.3)`, opacity: 1 },
          { transform: `translate(${x}px, ${y}px) rotate(${turn}deg) scale(1)`, opacity: 1, offset: 0.55 },
          {
            transform: `translate(${x * 1.25}px, ${y * 1.25 + 12}px) rotate(${turn + 40}deg) scale(0.8)`,
            opacity: 0,
          },
        ],
        { duration: 760, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" },
      );
    });
    void Promise.all(runs.map((r) => r.finished)).then(onDone, onDone);
    return () => runs.forEach((r) => r.cancel());
  }, [onDone]);

  return (
    <div ref={root} className={s.burst} style={{ left: at.x, top: at.y }} aria-hidden>
      {COLORS.map((c, i) => (
        <i key={i} style={{ background: c }} />
      ))}
    </div>
  );
}
