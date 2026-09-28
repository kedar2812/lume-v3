"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { useSound } from "@/components/feedback/SoundProvider";
import { Popover } from "@/components/ui/Popover";
import { SPRINGS, toMotion } from "@/lib/motion";
import { tasksClient } from "@/lib/tasks/client";
import { whenInWords } from "@/lib/tasks/format";
import type { SnoozePreset, TaskView } from "@/lib/tasks/types";
import s from "./tasks.module.css";

export const SNOOZE: { preset: SnoozePreset; label: string }[] = [
  { preset: "15m", label: "15 min" },
  { preset: "1h", label: "1 hour" },
  { preset: "evening", label: "This evening" },
  { preset: "tomorrow_morning", label: "Tomorrow morning" },
];

/**
 * The lead's next follow-up (Phase 3 spec §6): when, in words, and who it's for; a tick to finish it (the
 * `done` sound, or `cleared` for the day's last), and a menu to snooze or cancel it. Nothing when there's none.
 */
export function NextFollowUp({
  leadId,
  tz,
  meId,
  version,
  onChange,
}: {
  leadId: string;
  tz: string;
  meId: string;
  /** Bumped by the drawer when a follow-up is set, so this looks again. */
  version: number;
  onChange?(): void;
}) {
  const reduce = useReducedMotion();
  const sound = useSound();
  const [next, setNext] = useState<TaskView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await tasksClient.forLead(leadId);
    if (r.ok) setNext(r.data.items.find((t) => t.status === "open") ?? null);
  }, [leadId]);
  useEffect(() => void load(), [load, version]);

  const act = async (f: () => Promise<{ ok: boolean; message?: string }>) => {
    setError(null);
    const r = await f();
    if (!r.ok) return setError(r.message ?? "Something went wrong.");
    await load();
    onChange?.();
  };
  const done = (t: TaskView) =>
    act(async () => {
      const r = await tasksClient.done(t.id);
      if (r.ok) sound.play(r.data.clearedToday ? "cleared" : "done");
      return r;
    });

  return (
    <AnimatePresence initial={false}>
      {next && (
        <motion.section
          key={next.id}
          className={s.next}
          aria-label="Next follow-up"
          initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, height: "auto" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
          transition={toMotion(SPRINGS.default)}
        >
          <button
            type="button"
            className={s.tick}
            aria-label={`Mark “${next.title}” done`}
            onClick={() => void done(next)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
              <path
                d="M3.5 8.5 6.5 11.5 12.5 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <div className={s.nextText}>
            <span className={s.nextTitle}>{next.title}</span>
            <span className={s.nextMeta}>
              <span data-volatile data-overdue={new Date(next.dueAt) < new Date() || undefined}>
                {whenInWords(next.dueAt, new Date(), tz)}
              </span>
              {next.assignee.id !== meId && <> · for {next.assignee.name}</>}
            </span>
          </div>
          {next.canEdit && (
            <Popover
              label={`More for “${next.title}”`}
              trigger={<span aria-hidden>···</span>}
              triggerLabel={`More for “${next.title}”`}
              triggerClassName={s.more}
              role="menu"
              align="end"
            >
              {(close) => (
                <div className={s.menu}>
                  <p className={s.menuTitle}>Snooze until</p>
                  {SNOOZE.map((o) => (
                    <button
                      key={o.preset}
                      type="button"
                      role="menuitem"
                      className={s.menuItem}
                      onClick={() => {
                        close();
                        void act(() => tasksClient.snooze(next.id, { preset: o.preset }));
                      }}
                    >
                      {o.label}
                    </button>
                  ))}
                  <hr className={s.menuRule} />
                  <button
                    type="button"
                    role="menuitem"
                    className={`${s.menuItem} ${s.menuDanger}`}
                    onClick={() => {
                      close();
                      void act(() => tasksClient.cancel(next.id));
                    }}
                  >
                    Cancel follow-up
                  </button>
                </div>
              )}
            </Popover>
          )}
          {error && (
            <p role="alert" className={s.problem}>
              {error}
            </p>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
