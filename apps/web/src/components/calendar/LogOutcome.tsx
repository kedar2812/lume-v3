"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Switch";
import { calendarClient } from "@/lib/calendar/client";
import type { MeetingOutcome } from "@/lib/calendar/types";
import { nearDay, timeOf } from "@/lib/dates";
import { leadsClient } from "@/lib/leads/client";
import type { Stage } from "@/lib/leads/types";
import { pipelinesClient } from "@/lib/settings/pipelines";
import { tasksClient } from "@/lib/tasks/client";
import s from "./outcome.module.css";

/** "today", "tomorrow", "yesterday" inside a sentence; a date further off keeps its capitals. */
const near = (d: Date, tz: string) => {
  const w = nearDay(d, tz);
  return ["Today", "Tomorrow", "Yesterday"].includes(w) ? w.toLowerCase() : w;
};

/** What Log outcome needs of a meeting: the Calendar's, the drawer's and Today's all carry this much. */
export type OutcomeMeeting = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  lead: { id: string; name: string } | null;
};

const CHOICES: { value: MeetingOutcome; label: string; sub: (first: string) => string; tone: string }[] = [
  { value: "completed", label: "Held", sub: () => "It happened", tone: "ok" },
  {
    value: "no_show",
    label: "No-show",
    sub: (f) => (f ? `${f} didn't join` : "They didn't join"),
    tone: "bad",
  },
  { value: "rescheduled", label: "Rescheduled", sub: () => "Moved to another time", tone: "warn" },
];
const ICON: Record<MeetingOutcome, string> = {
  completed: "M5 12.5 9.5 17 19 7.5",
  no_show: "M5.6 5.6l12.8 12.8M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
  rescheduled: "M4 8h13l-3-3M20 16H7l3 3",
};

/**
 * Log outcome (canvas LogOutcome): Held, No-show or Rescheduled, with a note. Held can move the lead on to its
 * pipeline's next open stage; a no-show can set a Rebook follow-up; either can set a next step from the
 * follow-up presets. Saving records the outcome first; only once that's accepted do the move and the
 * follow-up happen. Logged by someone else meanwhile, it says who and keeps the note typed.
 */
export function LogOutcome({
  meeting: m,
  tz,
  onClose,
  onDone,
}: {
  meeting: OutcomeMeeting;
  tz: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const first = m.lead ? (m.lead.name.trim().split(/\s+/)[0] ?? m.lead.name) : "";
  const [choice, setChoice] = useState<MeetingOutcome | null>(null);
  const [note, setNote] = useState("");
  const [nextStage, setNextStage] = useState<Stage | null>(null);
  const [move, setMove] = useState(true);
  const [rebook, setRebook] = useState(true);
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([]);
  const [step, setStep] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Saved, but something after it didn't happen (a move the pipeline refused, a follow-up not set). */
  const [unfinished, setUnfinished] = useState<string[] | null>(null);

  // The lead's pipeline, for "Move to the next stage", and the follow-up time choices.
  useEffect(() => {
    void tasksClient.presets().then((r) => r.ok && setPresets(r.data.presets));
    if (!m.lead) return;
    void Promise.all([leadsClient.get(m.lead.id), pipelinesClient.list()]).then(([l, p]) => {
      if (!l.ok || !p.ok) return;
      const pipeline = p.data.pipelines.find((x) => x.id === l.data.lead.pipelineId);
      if (!pipeline) return;
      const stages = [...pipeline.stages].sort((a, b) => a.position - b.position);
      const at = stages.findIndex((x) => x.id === l.data.lead.stageId);
      setNextStage(at < 0 ? null : (stages.slice(at + 1).find((x) => x.kind === "open") ?? null));
    });
  }, [m.lead]);

  const save = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    const r = await calendarClient.patchMeeting(m.id, { status: choice, outcomeNote: note.trim() || null });
    if (!r.ok) {
      setBusy(false);
      return setError(r.message);
    }
    // The outcome is recorded; each step after it is checked, and one that didn't happen is said, never hidden.
    const missed: string[] = [];
    if (m.lead) {
      if (choice === "completed" && move && nextStage) {
        const r = await leadsClient.move(m.lead.id, nextStage.id);
        if (!r.ok) missed.push(`${first} wasn't moved to ${nextStage.name}: ${r.message.replace(/\.$/, "")}`);
      }
      if (choice === "no_show" && rebook && presets[0]) {
        const r = await tasksClient.create(m.lead.id, {
          title: `Rebook ${m.title}`,
          due: { preset: presets[0].id },
        });
        if (!r.ok) missed.push(`The Rebook follow-up wasn't set: ${r.message.replace(/\.$/, "")}`);
      }
      if (choice !== "no_show" && step) {
        const r = await tasksClient.create(m.lead.id, {
          title: `Next step after ${m.title}`,
          due: { preset: step },
        });
        if (!r.ok) missed.push(`The next step wasn't set: ${r.message.replace(/\.$/, "")}`);
      }
    }
    setBusy(false);
    if (missed.length) return setUnfinished(missed);
    onDone();
  };

  const title = first ? `How did it go with ${first}?` : "How did it go?";
  const start = new Date(m.startsAt);
  return (
    <Dialog label={title} onClose={onClose} wide>
      <div className={s.head}>
        <span className={s.icon} aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <rect x="3" y="5" width="18" height="16" rx="2.5" />
            <path d="M3 10h18M8 3v4M16 3v4" />
          </svg>
        </span>
        <div>
          <p className={s.when}>
            {m.title} · {near(start, tz)}, {timeOf(start, tz)} – {timeOf(new Date(m.endsAt), tz)}
          </p>
          <h2 className={s.title}>{title}</h2>
        </div>
      </div>

      <div role="radiogroup" aria-label="How it went" className={s.choices}>
        {CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={choice === c.value}
            className={s.choice}
            data-tone={c.tone}
            onClick={() => setChoice(c.value)}
          >
            <span className={s.choiceIcon} aria-hidden>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d={ICON[c.value]} />
              </svg>
            </span>
            <b>{c.label}</b>
            <span>{c.sub(first)}</span>
          </button>
        ))}
      </div>

      {choice ? (
        <div className={s.more}>
          <label className={s.noteLabel} htmlFor="outcome-note">
            Note
          </label>
          <textarea
            id="outcome-note"
            className={s.note}
            rows={3}
            maxLength={2000}
            placeholder={choice === "no_show" ? "Anything to remember when you rebook" : "What was decided"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {m.lead && choice === "completed" && nextStage && (
            <Switch label={`Move ${first} to ${nextStage.name}`} checked={move} onChange={setMove} />
          )}
          {m.lead && choice === "no_show" && presets.length > 0 && (
            <Switch label="Set a Rebook follow-up" checked={rebook} onChange={setRebook} />
          )}
          {m.lead && choice !== "no_show" && presets.length > 0 && (
            <label className={s.step}>
              <span>Next step</span>
              <select aria-label="Next step" value={step} onChange={(e) => setStep(e.target.value)}>
                <option value="">None for now</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      ) : (
        <p className={s.hint}>Pick one: LUME counts it in this week&apos;s numbers.</p>
      )}

      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {unfinished && (
        <p role="alert" className={s.error}>
          <b>Outcome saved.</b> {unfinished.join(". ")}.
        </p>
      )}
      <div className={s.foot}>
        <span className={s.private}>
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          Seen by whoever can see this meeting
        </span>
        {unfinished ? (
          <>
            {m.lead && (
              <Link className={s.later} href={`/leads?lead=${m.lead.id}`}>
                Open {first}
              </Link>
            )}
            <button type="button" className={s.save} onClick={onDone}>
              Done
            </button>
          </>
        ) : (
          <>
            <button type="button" className={s.later} onClick={onClose}>
              Later
            </button>
            <button type="button" className={s.save} disabled={!choice || busy} onClick={() => void save()}>
              Save outcome
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}
