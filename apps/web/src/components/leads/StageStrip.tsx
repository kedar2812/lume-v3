"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { tokenColor } from "@/lib/leads/colors";
import type { Stage } from "@/lib/leads/types";
import s from "./leads.module.css";

const leads = (n: number) => `${n} ${n === 1 ? "lead" : "leads"}`;

/**
 * The pipeline at a glance, and the quickest filter: every stage with how many leads are in it (under
 * the other filters). A click shows one stage and a second click shows all again; Ctrl or ⌘ adds stages.
 */
export function StageStrip({
  stages,
  counts,
  total,
  selected,
  onChange,
}: {
  stages: Stage[];
  /** Leads per stage id; null while the first answer is on its way. */
  counts: Record<string, number> | null;
  total: number | null;
  selected: string[];
  onChange: (stageIds: string[]) => void;
}) {
  // When the stages don't all fit, the strip scrolls sideways and fades on the side where more wait.
  const strip = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<"start" | "end" | "both" | null>(null);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const before = el.scrollLeft > 2;
      const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setMore(before && after ? "both" : before ? "start" : after ? "end" : null);
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [stages.length]);

  const pick = (e: MouseEvent, id: string) => {
    if (e.ctrlKey || e.metaKey)
      return onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    onChange(selected.length === 1 && selected[0] === id ? [] : [id]);
  };
  return (
    <div role="group" aria-label="Stages" className={s.strip} ref={strip} data-more={more ?? undefined}>
      <button
        type="button"
        className={s.stageTab}
        aria-pressed={selected.length === 0}
        aria-label={total === null ? "All stages" : `All stages, ${leads(total)}`}
        onClick={() => onChange([])}
      >
        All
        {total !== null && <b className={s.stageCount}>{total}</b>}
      </button>
      {stages.map((st) => {
        const n = counts ? (counts[st.id] ?? 0) : null;
        return (
          <button
            key={st.id}
            type="button"
            className={s.stageTab}
            aria-pressed={selected.includes(st.id)}
            aria-label={n === null ? st.name : `${st.name}, ${leads(n)}`}
            title="Ctrl or ⌘ click to add this stage to the others"
            data-empty={n === 0 || undefined}
            onClick={(e) => pick(e, st.id)}
          >
            <i className={s.dot} style={{ background: tokenColor(st.color) }} aria-hidden />
            {st.name}
            {n !== null && <b className={s.stageCount}>{n}</b>}
          </button>
        );
      })}
    </div>
  );
}
