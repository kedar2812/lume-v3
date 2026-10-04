"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/Switch";
import {
  MAX_RANGE_DAYS,
  RANGE_CHOICES,
  daysBetween,
  daysOf,
  monthGrid,
  monthTitle,
  rangeWords,
  shiftMonth,
  type RangeChoice,
} from "@/lib/analytics/range";
import s from "./range.module.css";

const DOW = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * The date range every Analytics board shares (canvas Main, the range popover): presets on the left, the month with
 * the range drawn on it, the business's timezone, and Compare with the period just before. Two clicks on the
 * calendar pick any range of up to a year. The popover grows from its button and closes on Esc or a click away.
 */
export function RangePicker({
  choice,
  custom,
  compare,
  today,
  tz,
  onChange,
}: {
  choice: RangeChoice;
  custom?: { from: string; to: string };
  compare: boolean;
  /** The business's today, "YYYY-MM-DD". */
  today: string;
  tz: string;
  onChange(next: { choice?: RangeChoice; custom?: { from: string; to: string }; compare?: boolean }): void;
}) {
  const reduce = !!useReducedMotion();
  const [open, setOpen] = useState(false);
  const [from, to] = daysOf(choice, today, custom);
  const words = rangeWords(choice, today, custom);
  const [month, setMonth] = useState(to);
  /** The first day of a custom range being picked, waiting for its last. */
  const [start, setStart] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setMonth(to);
    setStart(null);
    const away = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
    // Opening starts from the range shown; `to` is read once per opening.
  }, [open]);

  const pick = (c: Exclude<RangeChoice, "custom">) => {
    onChange({ choice: c });
    setOpen(false);
    button.current?.focus();
  };
  const tapDay = (d: string) => {
    if (d > today) return;
    if (!start) return setStart(d);
    const [a, b] = d < start ? [d, start] : [start, d];
    if (daysBetween(a, b) > MAX_RANGE_DAYS) return;
    setStart(null);
    onChange({ choice: "custom", custom: { from: a, to: b } });
    setOpen(false);
    button.current?.focus();
  };
  // While picking: the range from the first day to the one under the pointer.
  const [lo, hi] = start ? ([start, hover ?? start].sort() as [string, string]) : [from, to];

  return (
    <div className={s.wrap} ref={wrap}>
      <button
        ref={button}
        type="button"
        className={s.button}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M8 2v3M16 2v3" />
          <rect x="3" y="4" width="18" height="17" rx="2" />
          <path d="M3 9h18" />
        </svg>
        {words.label}
        {compare && <span className={s.vs}>{words.vs}</span>}
        <svg viewBox="0 0 24 24" aria-hidden className={s.chev}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className={s.pop}
            role="dialog"
            aria-label="Date range"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: -6, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: -4, filter: "blur(4px)" }}
            transition={reduce ? { duration: 0.15 } : { type: "spring", bounce: 0.18, duration: 0.5 }}
          >
            <div className={s.presets}>
              {RANGE_CHOICES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={c.id === choice}
                  autoFocus={c.id === choice}
                  onClick={() => pick(c.id)}
                >
                  {c.label}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={choice === "custom"}
                onClick={() => setStart(null)}
                title="Pick the first and last day on the calendar"
              >
                Custom…
              </button>
            </div>
            <div className={s.cal}>
              <div className={s.month}>
                <button
                  type="button"
                  aria-label="The month before"
                  onClick={() => setMonth((m) => shiftMonth(m, -1))}
                >
                  ‹
                </button>
                <span>{monthTitle(month)}</span>
                <button
                  type="button"
                  aria-label="The month after"
                  disabled={month.slice(0, 7) >= today.slice(0, 7)}
                  onClick={() => setMonth((m) => shiftMonth(m, 1))}
                >
                  ›
                </button>
                <span className={s.tz}>Times in {tz}</span>
              </div>
              <div
                className={s.grid}
                role="grid"
                aria-label={`${monthTitle(month)}: pick a first and last day`}
              >
                {DOW.map((d, i) => (
                  <span key={i} className={s.dow} aria-hidden>
                    {d}
                  </span>
                ))}
                {monthGrid(month).map(({ day, inMonth }) => {
                  const inside = day >= lo && day <= hi;
                  const end = day === lo || day === hi;
                  return (
                    <button
                      key={day}
                      type="button"
                      className={s.day}
                      data-out={!inMonth || undefined}
                      data-in={inside && !end ? "" : undefined}
                      data-end={inside && end ? "" : undefined}
                      data-today={day === today || undefined}
                      disabled={day > today}
                      aria-label={new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                        weekday: "long",
                        timeZone: "UTC",
                      })}
                      aria-pressed={inside}
                      onClick={() => tapDay(day)}
                      onPointerEnter={() => setHover(day)}
                    >
                      {Number(day.slice(8))}
                    </button>
                  );
                })}
              </div>
              <p className={s.hint} aria-live="polite">
                {start ? "Now pick the last day." : "Pick two days for any range up to a year."}
              </p>
              <div className={s.compare}>
                <div>
                  <b>Compare</b>
                  <span>with the period just before</span>
                </div>
                <Switch
                  checked={compare}
                  onChange={(v) => onChange({ compare: v })}
                  label="Compare with the period before"
                  labelHidden
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
