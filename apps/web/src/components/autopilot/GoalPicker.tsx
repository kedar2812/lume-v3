"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./start.module.css";

/** The goal as the sheet holds it: a brief is only sent once it's locked in. */
export type GoalChoice =
  { kind: "stage"; stageId: string } | { kind: "reply" } | { kind: "brief"; text: string; locked: boolean };

const MIN = 15;
const MAX = 600;
/** Fits any business, names none. */
const EXAMPLE =
  "Invite them to a short call this week to talk through what they need. Offer to send our price list first. Keep it warm and brief.";

/**
 * The goal (Autopilot spec 2026-10-19 §1.1): the business's goal stages as ready-made goals, "Get a reply", or "Write
 * your own": a brief of up to 600 characters, confirmed before it's used ("Your goal is locked in"). The goal is the
 * brief for every message LUME AI writes in the run.
 */
export function GoalPicker({
  goals,
  value,
  onChange,
}: {
  goals: { kind: "stage"; stageId: string; name: string }[];
  value: GoalChoice;
  onChange(v: GoalChoice): void;
}) {
  const reduce = useReducedMotion();
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const brief = value.kind === "brief" ? value : null;
  const options: { key: string; label: string; pick: GoalChoice; on: boolean }[] = [
    ...goals.map((g) => ({
      key: g.stageId,
      label: g.name,
      pick: { kind: "stage" as const, stageId: g.stageId },
      on: value.kind === "stage" && value.stageId === g.stageId,
    })),
    { key: "reply", label: "Get a reply", pick: { kind: "reply" }, on: value.kind === "reply" },
    {
      key: "brief",
      label: "Write your own",
      pick: { kind: "brief", text: brief?.text ?? "", locked: false },
      on: !!brief,
    },
  ];
  // Choosing Write your own with a click, or Edit, puts the cursor in the box; arrowing past it doesn't.
  const editing = !!brief && !brief.locked;
  const wantFocus = useRef(false);
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.max(
    0,
    options.findIndex((o) => o.on),
  );
  // The radio pattern: arrows choose the next goal (wrapping) and move focus with it.
  const onKey = (e: KeyboardEvent) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = (at + step + options.length) % options.length;
    onChange(options[next]!.pick);
    chips.current[next]?.focus();
  };
  useEffect(() => {
    if (editing && wantFocus.current) box.current?.focus();
    wantFocus.current = false;
  }, [editing]);

  return (
    <div className={s.goal}>
      <div role="radiogroup" aria-label="Goal" className={s.goalChips} onKeyDown={onKey}>
        {options.map((o, i) => (
          <button
            key={o.key}
            ref={(el) => {
              chips.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={o.on}
            tabIndex={i === at ? 0 : -1}
            className={s.goalChip}
            onClick={() => {
              if (o.on) return;
              wantFocus.current = o.key === "brief";
              onChange(o.pick);
            }}
          >
            {o.key === "brief" && (
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            )}
            {o.label}
          </button>
        ))}
      </div>
      {goals.length ? (
        <p className={s.hint}>Ready-made goals come from your pipeline</p>
      ) : (
        <p className={s.hint}>
          Ready-made goals come from your pipeline.{" "}
          <Link href="/settings/ai" className={s.link}>
            Choose goal stages
          </Link>
        </p>
      )}

      <AnimatePresence initial={false} mode="popLayout">
        {brief && !brief.locked && (
          <motion.div
            key="write"
            className={s.write}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={toMotion(SPRINGS.default)}
          >
            <label htmlFor={`${id}-brief`} className={s.label}>
              Your goal
            </label>
            <textarea
              ref={box}
              id={`${id}-brief`}
              className={s.textarea}
              rows={4}
              maxLength={MAX}
              aria-describedby={`${id}-hint ${id}-count`}
              placeholder="What you want from these leads, who they are, and what to offer"
              value={brief.text}
              onChange={(e) => onChange({ kind: "brief", text: e.target.value, locked: false })}
            />
            <div className={s.writeFoot}>
              <span id={`${id}-hint`} className={s.hint}>
                A good brief says the outcome, the offer and the tone
              </span>
              <span id={`${id}-count`} className={s.count}>
                {brief.text.length} of {MAX}
              </span>
            </div>
            <div className={s.writeActions}>
              <button
                type="button"
                className={s.quiet}
                onClick={() => onChange({ kind: "brief", text: EXAMPLE, locked: false })}
              >
                Use an example
              </button>
              <button
                type="button"
                className={s.confirm}
                disabled={brief.text.trim().length < MIN}
                onClick={() => onChange({ kind: "brief", text: brief.text.trim(), locked: true })}
              >
                Confirm
              </button>
            </div>
          </motion.div>
        )}
        {brief?.locked && (
          <motion.div
            key="locked"
            className={s.locked}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={toMotion(SPRINGS.default)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden className={s.lock}>
              <rect x="5" y="11" width="14" height="9" rx="2.5" fill="currentColor" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
            <div className={s.lockedWords}>
              <b>Your goal is locked in. LUME AI writes from this.</b>
              <p>{brief.text}</p>
            </div>
            <button
              type="button"
              className={s.quiet}
              aria-label="Edit your goal"
              onClick={() => {
                wantFocus.current = true;
                onChange({ kind: "brief", text: brief.text, locked: false });
              }}
            >
              Edit
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
