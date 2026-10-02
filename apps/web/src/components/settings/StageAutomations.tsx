"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState } from "react";
import { describeRule, onEnterSchema, type OnEnter, type StageRule } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { Person } from "@/lib/leads/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import a from "./automations.module.css";
import s from "./settings.module.css";

const MAX = 5;
export type Moves = { afterSentStageId: string | null; afterReplyStageId: string | null };
const MOVES: { key: keyof Moves; label: string }[] = [
  { key: "afterSentStageId", label: "After a message is sent, move to" },
  { key: "afterReplyStageId", label: "After a reply, move to" },
];
const OWNER = "lead_owner";
/** A reminder message the meeting reminder can use (4A templates). */
export type ReminderTemplate = { id: string; name: string; body: string };
export type NewRuleKind = "create_task" | "notify" | "cancel_open_tasks" | "remind_before_meeting";
const REMIND_HOURS = 2;
/** A new automation of a kind, as the editor first shows it. */
export const newRule = (type: NewRuleKind, templateId = ""): StageRule =>
  type === "create_task"
    ? { id: crypto.randomUUID(), type, title: "", dueIn: { n: 2, unit: "day" }, assignee: OWNER }
    : type === "notify"
      ? { id: crypto.randomUUID(), type, to: [] }
      : type === "remind_before_meeting"
        ? { id: crypto.randomUUID(), type, hoursBefore: REMIND_HOURS, templateId }
        : { id: crypto.randomUUID(), type };

/**
 * What a stage does when a lead enters it (3C; frontend spec §8.10): up to five automations, each a card
 * that reads as a sentence as it's shaped. Saved together, with the stage; refused in LUME's words first.
 */
export function StageAutomations({
  stage,
  rules: initial,
  moves: initialMoves = { afterSentStageId: null, afterReplyStageId: null },
  targets = [],
  people,
  templates = [],
  onSave,
  onClose,
}: {
  stage: { id: string; name: string };
  rules: StageRule[];
  /** The reminder messages the meeting reminder may send (5D); none: write one in Templates first. */
  templates?: ReminderTemplate[];
  /** Where a lead here goes after a message or a reply (4A). */
  moves?: Moves;
  /** Where it may go: this pipeline's other stages that a move can reach. */
  targets?: { id: string; name: string }[];
  people: Person[];
  /** Saves (the moves only when they changed); resolves to LUME's words when refused, else null. */
  onSave: (onEnter: OnEnter, moves: Partial<Moves>) => Promise<string | null>;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const [rules, setRules] = useState<StageRule[]>(initial);
  const [moves, setMoves] = useState<Moves>(initialMoves);
  const moveId = useId();
  const [problem, setProblem] = useState<string | null>(null);
  /** The automation just removed, for Undo (5D Task 9). */
  const [removed, setRemoved] = useState<{ rule: StageRule; at: number } | null>(null);
  const hasReminder = rules.some((r) => r.type === "remind_before_meeting");
  const [busy, setBusy] = useState(false);
  const active = people.filter((p) => p.active);
  // Someone no longer active stays visible where a rule still names them, so they can be taken out
  // (3C final review, Important 6).
  const named = (p: Person) => (p.active ? p.name : `${p.name} (no longer active)`);
  const names = new Map(people.map((p) => [p.id, named(p)]));
  const inactiveIn = (ids: string[]) => people.filter((p) => !p.active && ids.includes(p.id));
  const change = (i: number, next: StageRule) => {
    setRules((rs) => rs.map((r, j) => (j === i ? next : r)));
    setProblem(null);
  };

  const save = async () => {
    const parsed = onEnterSchema.safeParse({ rules });
    if (!parsed.success) return setProblem(parsed.error.issues[0]?.message ?? "Something here isn't right.");
    setBusy(true);
    const changed = Object.fromEntries(
      MOVES.filter((m) => moves[m.key] !== initialMoves[m.key]).map((m) => [m.key, moves[m.key]]),
    ) as Partial<Moves>;
    const refused = await onSave(parsed.data, changed);
    setBusy(false);
    if (refused) setProblem(refused);
    else onClose();
  };

  return (
    <Dialog label={`What ${stage.name} does`} onClose={onClose} wide>
      <h2 className={s.dialogTitle}>What {stage.name} does</h2>
      <fieldset className={a.moves}>
        <legend className={a.movesHead}>Moves</legend>
        {MOVES.map((m) => (
          <div key={m.key} className={a.moveRow}>
            <label htmlFor={`${moveId}-${m.key}`}>{m.label}</label>
            <select
              id={`${moveId}-${m.key}`}
              value={moves[m.key] ?? ""}
              onChange={(e) => {
                setMoves((cur) => ({ ...cur, [m.key]: e.target.value || null }));
                setProblem(null);
              }}
            >
              <option value="">Stay here</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </fieldset>
      <h3 className={a.sectionHead}>When a lead enters</h3>
      <p className={s.dialogText}>
        LUME does these, in order. Runs when a lead moves here, or arrives here from a webhook or a sheet.
        Imports don&apos;t run it.
      </p>
      <ol className={a.cards} aria-label="Automations">
        <AnimatePresence initial={false}>
          {rules.map((r, i) => (
            <motion.li
              key={r.id}
              className={a.card}
              layout={!reduce}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
              transition={toMotion(SPRINGS.default)}
            >
              <div className={a.cardHead}>
                <span className={a.step} aria-hidden>
                  {i + 1}
                </span>
                <p className={a.sentence}>{describeRule(r, names)}</p>
                <button
                  type="button"
                  className={a.remove}
                  aria-label={`Remove automation ${i + 1}`}
                  onClick={() => {
                    setRemoved({ rule: r, at: i });
                    setRules((rs) => rs.filter((_, j) => j !== i));
                  }}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
              {r.type === "create_task" && (
                <div className={a.fields}>
                  <input
                    className={a.title}
                    aria-label="Follow-up title"
                    placeholder="Follow-up title, e.g. Send the plan"
                    maxLength={200}
                    value={r.title}
                    onChange={(e) => change(i, { ...r, title: e.target.value })}
                  />
                  <span className={a.word}>in</span>
                  <input
                    className={a.num}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={365}
                    aria-label="How long after"
                    value={Number.isFinite(r.dueIn.n) ? r.dueIn.n : ""}
                    onChange={(e) =>
                      change(i, { ...r, dueIn: { ...r.dueIn, n: Math.round(Number(e.target.value)) } })
                    }
                  />
                  <select
                    aria-label="Hours or days"
                    value={r.dueIn.unit}
                    onChange={(e) =>
                      change(i, { ...r, dueIn: { ...r.dueIn, unit: e.target.value as "hour" | "day" } })
                    }
                  >
                    <option value="hour">hours</option>
                    <option value="day">days</option>
                  </select>
                  <span className={a.word}>for</span>
                  <select
                    aria-label="For"
                    value={r.assignee === OWNER ? OWNER : r.assignee.userId}
                    onChange={(e) =>
                      change(i, {
                        ...r,
                        assignee: e.target.value === OWNER ? OWNER : { userId: e.target.value },
                      })
                    }
                  >
                    <option value={OWNER}>the lead&apos;s owner</option>
                    {[...active, ...inactiveIn(r.assignee === OWNER ? [] : [r.assignee.userId])].map((p) => (
                      <option key={p.id} value={p.id}>
                        {named(p)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {r.type === "remind_before_meeting" && (
                <div className={a.remind}>
                  <div className={a.fields}>
                    <span className={a.word}>Send it</span>
                    <span className={a.stepper}>
                      <button
                        type="button"
                        aria-label="One hour less"
                        disabled={r.hoursBefore <= 1}
                        onClick={() => change(i, { ...r, hoursBefore: r.hoursBefore - 1 })}
                      >
                        −
                      </button>
                      <input
                        className={a.num}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={72}
                        aria-label="Hours before the meeting"
                        value={Number.isFinite(r.hoursBefore) ? r.hoursBefore : ""}
                        onChange={(e) => change(i, { ...r, hoursBefore: Math.round(Number(e.target.value)) })}
                      />
                      <button
                        type="button"
                        aria-label="One hour more"
                        disabled={r.hoursBefore >= 72}
                        onClick={() => change(i, { ...r, hoursBefore: r.hoursBefore + 1 })}
                      >
                        +
                      </button>
                    </span>
                    <span className={a.word}>
                      {r.hoursBefore === 1 ? "hour" : "hours"} before the meeting
                    </span>
                  </div>
                  <div className={a.fields}>
                    <span className={a.word}>Message</span>
                    <select
                      aria-label="Message"
                      value={r.templateId}
                      onChange={(e) => change(i, { ...r, templateId: e.target.value })}
                    >
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {templates.find((t) => t.id === r.templateId) && (
                    <p className={a.preview} data-testid="reminder-preview">
                      <img src="/brand/whatsapp.svg" alt="" width={14} height={14} />
                      {templates.find((t) => t.id === r.templateId)!.body}
                    </p>
                  )}
                  <p className={a.note}>If a call is booked sooner than this, LUME skips the reminder.</p>
                </div>
              )}
              {r.type === "notify" && (
                <fieldset className={a.who}>
                  <legend className={s.srOnly}>Who to tell</legend>
                  {[
                    { id: OWNER, name: "The lead's owner", active: true },
                    ...active,
                    ...inactiveIn(r.to.flatMap((t) => (t === OWNER ? [] : [t.userId]))),
                  ].map((p) => {
                    const on = r.to.some((t) => (t === OWNER ? p.id === OWNER : t.userId === p.id));
                    return (
                      <label key={p.id} className={a.pill} data-on={on || undefined}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const to = r.to.filter((t) => (t === OWNER ? p.id !== OWNER : t.userId !== p.id));
                            if (e.target.checked) to.push(p.id === OWNER ? OWNER : { userId: p.id });
                            change(i, { ...r, to });
                          }}
                        />
                        {p.id === OWNER ? p.name : named(p)}
                      </label>
                    );
                  })}
                </fieldset>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
      {removed && (
        <p role="status" className={a.removed}>
          Removed
          <button
            type="button"
            onClick={() => {
              setRules((rs) => [...rs.slice(0, removed.at), removed.rule, ...rs.slice(removed.at)]);
              setRemoved(null);
            }}
          >
            Undo
          </button>
        </p>
      )}
      {!rules.length && (
        <p className={a.none}>Nothing yet. Leads enter {stage.name} and LUME leaves them be.</p>
      )}
      <div className={a.add} role="group" aria-label="Add an automation">
        {(
          [
            ["create_task", "Set a follow-up"],
            ["cancel_open_tasks", "Clear open follow-ups"],
            ["notify", "Tell someone"],
            ["remind_before_meeting", "Remind the lead before their call"],
          ] as const
        ).map(([type, label]) => (
          <button
            key={type}
            type="button"
            className={a.addBtn}
            disabled={
              rules.length >= MAX ||
              (type === "remind_before_meeting" && (hasReminder || templates.length === 0))
            }
            onClick={() => {
              setRules((rs) => [...rs, newRule(type, templates[0]?.id)]);
              setRemoved(null);
              setProblem(null);
            }}
          >
            <span aria-hidden>+</span> {label}
          </button>
        ))}
      </div>
      {templates.length === 0 && !hasReminder && (
        <p className={s.muted}>
          Write a reminder message in Templates first, to remind a lead before their call.
        </p>
      )}
      {rules.length >= MAX && <p className={s.muted}>Five is the most a stage can do.</p>}
      <div className={s.dialogActions}>
        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}
