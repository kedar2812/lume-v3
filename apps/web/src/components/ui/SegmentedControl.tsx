"use client";
import { motion } from "motion/react";
import { useId, useRef, type KeyboardEvent } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./SegmentedControl.module.css";

type Option<T extends string> = { readonly value: T; readonly label: string };
type Props<T extends string> = {
  label: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
};

/** A radio group whose selection thumb slides with a spring (shared layout, no measuring). */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  size = "md",
}: Props<T>) {
  const layoutId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function onKey(e: KeyboardEvent) {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={[s.group, size === "sm" && s.sm].filter(Boolean).join(" ")}
      onKeyDown={onKey}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={s.item}
            onClick={() => !on && onChange(o.value)}
          >
            {on && (
              <motion.span layoutId={layoutId} className={s.thumb} transition={toMotion(SPRINGS.default)} />
            )}
            <span className={s.label}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
