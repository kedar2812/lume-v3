"use client";
import { useEffect, useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import b from "@/components/ui/Button.module.css";
import { Popover } from "@/components/ui/Popover";
import { minutes } from "@/lib/analytics/words";
import { leadsClient } from "@/lib/leads/client";
import { tasksClient } from "@/lib/tasks/client";
import { localInputToIso } from "@/lib/tasks/format";
import s from "./logcall.module.css";

type Outcome = "talked" | "no_answer" | "left_message";
const OUTCOMES: { id: Outcome; label: string; key: string; icon: string }[] = [
  {
    id: "talked",
    label: "Talked",
    key: "1",
    icon: "M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5.1A8 8 0 1 1 21 12Z",
  },
  {
    id: "no_answer",
    label: "No answer",
    key: "2",
    icon: "M15.5 3.5l5 5M20.5 3.5l-5 5M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z",
  },
  {
    id: "left_message",
    label: "Left a message",
    key: "3",
    icon: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
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
 */
export function LogCall({
  lead,
  tz,
  onLogged,
}: {
  lead: { id: string; name: string };
  tz: string;
  onLogged(): void;
}) {
  const { toast } = useToast();
  const [outcome, setOutcome] = useState<Outcome>("talked");
  const [note, setNote] = useState("");
  const [next, setNext] = useState<string>("none");
  const [picked, setPicked] = useState("");
  const [choices, setChoices] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const first = lead.name.split(" ")[0] || "them";

  const reset = () => {
    setOutcome("talked");
    setNote("");
    setNext("none");
    setPicked("");
    setProblem(null);
  };
  const choose = (o: Outcome) => {
    setOutcome(o);
    // No answer, or a message left: trying again tomorrow is the usual next step.
    if (o !== "talked" && next === "none" && choices.some((c) => c.id === "tomorrow_10"))
      setNext("tomorrow_10");
  };

  const log = async (close: () => void) => {
    const at = next === "pick" ? localInputToIso(picked, tz) : null;
    if (next === "pick" && !at) return setProblem("Pick a date and time.");
    setBusy(true);
    setProblem(null);
    const r = await leadsClient.logCall(lead.id, outcome, note.trim() || undefined);
    if (!r.ok) {
      setBusy(false);
      return setProblem(r.message ?? "LUME couldn’t log the call just now.");
    }
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
    onLogged();
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
            <svg className={s.ico} viewBox="0 0 24 24" aria-hidden>
              <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" />
            </svg>
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
      <div className={s.outcomes} role="radiogroup" aria-label="How did the call go?">
        {OUTCOMES.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={p.outcome === o.id}
            aria-keyshortcuts={o.key}
            className={s.oc}
            onClick={() => p.choose(o.id)}
          >
            <span className={s.ocIco} aria-hidden>
              <svg viewBox="0 0 24 24">
                <path d={o.icon} />
              </svg>
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
        <div className={s.nexts} role="radiogroup" aria-labelledby="logcall-next">
          {[{ id: "none", label: "No follow-up" }, ...p.choices, { id: "pick", label: "Pick a time…" }].map(
            (c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={p.next === c.id}
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
      {p.problem && (
        <p className={s.problem} role="alert">
          {p.problem}
        </p>
      )}
      <div className={s.foot}>
        <button type="button" className={s.cancel} onClick={p.onCancel}>
          Cancel
        </button>
        <button type="button" className={s.log} disabled={p.busy} onClick={p.onLog}>
          {p.busy ? "Logging…" : "Log call"}
        </button>
      </div>
    </div>
  );
}
