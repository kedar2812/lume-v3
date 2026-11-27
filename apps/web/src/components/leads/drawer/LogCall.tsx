"use client";
import { ICON_SIZE, UI_ICONS, type Icon } from "@/components/ui/icons";
import { useEffect, useState, type ReactNode } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import b from "@/components/ui/Button.module.css";
import { Popover } from "@/components/ui/Popover";
import { minutes } from "@/lib/analytics/words";
import { leadsClient } from "@/lib/leads/client";
import type { LostReason, Stage } from "@/lib/leads/types";
import { listsClient } from "@/lib/settings/lists";
import { choiceReady, moveOf, StagePick, STAYS, type StageChoice } from "../StagePick";
import { tasksClient } from "@/lib/tasks/client";
import { localInputToIso } from "@/lib/tasks/format";
import s from "./logcall.module.css";
import { roving } from "@/lib/roving";

type Outcome = "talked" | "no_answer" | "left_message";
const OUTCOMES: { id: Outcome; label: string; key: string; icon: Icon }[] = [
  {
    id: "talked",
    label: "Talked",
    key: "1",
    icon: UI_ICONS.talked,
  },
  {
    id: "no_answer",
    label: "No answer",
    key: "2",
    icon: UI_ICONS.noAnswer,
  },
  {
    id: "left_message",
    label: "Left a message",
    key: "3",
    icon: UI_ICONS.leftMessage,
  },
];
/** What the follow-up is called, from how the call went. */
const TITLE: Record<Outcome, string> = {
  talked: "Follow up",
  no_answer: "Try calling again",
  left_message: "Call back",
};

/**
 * Log a call (the approved LogCall board): how it went (1, 2, 3), what they said, and the next step as a follow-up,
 * all in one; LUME says when it was the lead's first contact and how soon it came. C opens it from the drawer.
 * Given the lead's pipeline, it can move the lead to any stage too (owner 2026-11-27), once the call is logged.
 */
export function LogCall({
  lead,
  tz,
  onLogged,
  stage,
  onMove,
}: {
  lead: { id: string; name: string };
  tz: string;
  /** The lead's pipeline's stages in order and the one it's in: the Stage row (none without it). */
  stage?: { stages: Stage[]; currentId: string };
  /** Moves the lead (the drawer's move, which asks for any fields the stage needs). */
  onMove?: (stage: Stage, extra: { lostReasonId?: string }) => Promise<unknown>;
  /** The call it saved, and whether it has words in it (LUME AI can read those into a next step). */
  onLogged(activityId: string, said: boolean): void;
}) {
  const { toast } = useToast();
  const [outcome, setOutcome] = useState<Outcome>("talked");
  const [note, setNote] = useState("");
  const [next, setNext] = useState<string>("none");
  const [picked, setPicked] = useState("");
  const [choices, setChoices] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState<StageChoice>(STAYS);
  const [reasons, setReasons] = useState<LostReason[] | null>(null);
  const first = lead.name.split(" ")[0] || "them";
  const lostPicked = stage?.stages.find((x) => x.id === moveTo.stageId)?.kind === "lost";
  // A lost stage asks why: the reasons are read once one is picked.
  useEffect(() => {
    if (!lostPicked || reasons) return;
    void listsClient.reasons().then((r) => setReasons(r.ok ? r.data.lostReasons : []));
  }, [lostPicked, reasons]);

  const reset = () => {
    setOutcome("talked");
    setNote("");
    setNext("none");
    setPicked("");
    setProblem(null);
    setMoveTo(STAYS);
  };
  const choose = (o: Outcome) => {
    setOutcome(o);
    // No answer, or a message left: trying again tomorrow is the usual next step.
    if (o !== "talked" && next === "none" && choices.some((c) => c.id === "tomorrow_10"))
      setNext("tomorrow_10");
  };

  const log = async (close: () => void) => {
    const at = next === "pick" ? localInputToIso(picked, tz) : null;
    const said = note.trim();
    if (next === "pick" && !at) return setProblem("Pick a date and time.");
    setBusy(true);
    setProblem(null);
    const r = await leadsClient.logCall(lead.id, outcome, said || undefined);
    if (!r.ok) {
      setBusy(false);
      return setProblem(r.message ?? "LUME couldn’t log the call just now.");
    }
    const mv = stage && onMove ? moveOf(moveTo, stage.stages) : null;
    let followUp = true;
    if (next !== "none") {
      const t = await tasksClient.create(lead.id, {
        title: TITLE[outcome],
        due: at ? { at } : { preset: next },
        remindMinutes: [0],
        recurrence: null,
      });
      followUp = t.ok;
    }
    setBusy(false);
    close();
    reset();
    onLogged(r.data.activity.id, said !== "");
    // A follow-up that wasn't set comes first: the rep must not think one exists.
    const fc = r.data.firstContact;
    const firstWords = !fc
      ? null
      : "days" in fc
        ? `First contact with ${first}: ${fc.days} ${fc.days === 1 ? "day" : "days"} after the enquiry date.`
        : `First contact with ${first}: ${minutes(fc.minutes)} after the enquiry.`;
    const detail = [followUp ? null : "The follow-up wasn’t set. Add it with Follow-up.", firstWords]
      .filter(Boolean)
      .join(" ");
    toast({ tone: followUp ? "ok" : "warn", title: "Call logged", ...(detail ? { detail } : {}) });
    // The call is in; then the move (the drawer's, which says itself if the stage refused it).
    if (mv && onMove) await onMove(mv.stage, mv.extra);
  };

  return (
    <span data-log-call>
      <Popover
        label="Log a call"
        role="dialog"
        size="form"
        align="end"
        trigger={
          <>
            <UI_ICONS.call size={ICON_SIZE.md} aria-hidden className={s.ico} />
            Log a call
            <kbd className={s.kbd} aria-hidden>
              C
            </kbd>
          </>
        }
        triggerClassName={b.btn}
        triggerLabel="Log a call (C)"
      >
        {(close) => (
          <Panel
            outcome={outcome}
            choose={choose}
            note={note}
            setNote={setNote}
            next={next}
            setNext={setNext}
            picked={picked}
            setPicked={setPicked}
            choices={choices}
            setChoices={setChoices}
            busy={busy}
            problem={problem}
            first={first}
            stageRow={
              stage && onMove ? (
                <StagePick
                  first={first}
                  stages={stage.stages}
                  currentId={stage.currentId}
                  value={moveTo}
                  reasons={reasons}
                  onChange={setMoveTo}
                />
              ) : null
            }
            ready={!stage || !onMove || choiceReady(moveTo, stage.stages)}
            onCancel={() => {
              close();
              reset();
            }}
            onLog={() => void log(close)}
          />
        )}
      </Popover>
    </span>
  );
}

function Panel(p: {
  outcome: Outcome;
  choose(o: Outcome): void;
  note: string;
  setNote(v: string): void;
  next: string;
  setNext(v: string): void;
  picked: string;
  setPicked(v: string): void;
  choices: { id: string; label: string }[];
  setChoices(c: { id: string; label: string }[]): void;
  busy: boolean;
  problem: string | null;
  first: string;
  stageRow: ReactNode;
  ready: boolean;
  onCancel(): void;
  onLog(): void;
}) {
  // The follow-up time choices are Settings → Follow-ups' own, read each time it opens.
  useEffect(() => {
    void tasksClient.presets().then((r) => r.ok && p.setChoices(r.data.presets));
  }, []);
  // 1, 2, 3 pick how it went, while not typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      const o = OUTCOMES.find((x) => x.key === e.key);
      if (o) {
        e.preventDefault();
        p.choose(o.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className={s.panel}>
      <h3 className={s.h}>How did the call go?</h3>
      <div
        className={s.outcomes}
        role="radiogroup"
        aria-label="How did the call go?"
        onKeyDown={(e) => roving(e, "radio")}
      >
        {OUTCOMES.map((o, i) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={p.outcome === o.id}
            tabIndex={p.outcome === o.id || (!p.outcome && i === 0) ? 0 : -1}
            aria-keyshortcuts={o.key}
            className={s.oc}
            onClick={() => p.choose(o.id)}
          >
            <span className={s.ocIco} aria-hidden>
              <o.icon size={ICON_SIZE.sm} />
            </span>
            <b>{o.label}</b>
            <span className={s.press}>Press {o.key}</span>
          </button>
        ))}
      </div>
      <label className={s.lbl}>
        <span>
          What did they say? <em>Optional</em>
        </span>
        <textarea
          rows={2}
          maxLength={2000}
          value={p.note}
          placeholder="What they want, and anything to remember"
          onChange={(e) => p.setNote(e.target.value)}
        />
      </label>
      <div className={s.lbl}>
        <span id="logcall-next">Next step</span>
        <div
          className={s.nexts}
          role="radiogroup"
          aria-labelledby="logcall-next"
          onKeyDown={(e) => roving(e, "radio")}
        >
          {[{ id: "none", label: "No follow-up" }, ...p.choices, { id: "pick", label: "Pick a time…" }].map(
            (c, i) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={p.next === c.id}
                tabIndex={p.next === c.id || (!p.next && i === 0) ? 0 : -1}
                className={s.nx}
                onClick={() => p.setNext(c.id)}
              >
                {c.label}
              </button>
            ),
          )}
        </div>
        {p.next === "pick" && (
          <input
            className={s.pick}
            type="datetime-local"
            aria-label="When to follow up"
            value={p.picked}
            onChange={(e) => p.setPicked(e.target.value)}
          />
        )}
      </div>
      {p.stageRow && <div className={s.stageRow}>{p.stageRow}</div>}
      {p.problem && (
        <p className={s.problem} role="alert">
          {p.problem}
        </p>
      )}
      <div className={s.foot}>
        <button type="button" className={s.cancel} onClick={p.onCancel}>
          Cancel
        </button>
        <button type="button" className={s.log} disabled={p.busy || !p.ready} onClick={p.onLog}>
          {p.busy ? "Logging…" : "Log call"}
        </button>
      </div>
    </div>
  );
}
