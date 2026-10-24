"use client";
import { firstNameOf } from "@lume/core/shared";
import { useEffect, useState, type ReactNode } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { revealed } from "@/lib/autopilot/reveal";
import type { RunLead } from "@/lib/autopilot/types";
import s from "./live.module.css";

/** How often the words move on: often enough to read as typing, a word at a time. */
const TICK_MS = 40;

/** The revealed words, with a template's filled values in <mark> where they've appeared. */
function withMarks(text: string, marks: [number, number][]): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of marks) {
    if (a >= text.length) break;
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={a}>{text.slice(a, Math.min(b, text.length))}</mark>);
    at = Math.min(b, text.length);
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * LUME AI typing in the open (spec 2026-10-19 §2): the message it wrote appears at reading speed in a composer, a
 * template's filled values highlighted and "Approved template · <name>" above it. Pause freezes it where it was
 * (`frozenAt`); it's never sent half-written. Clicking it takes the lead over (`onTakeOver`, offered only to someone who
 * may), the way you interrupt by starting to type. A screen reader hears the whole message once, not each word.
 */
export function TypingComposer({
  leadName,
  speaker,
  draft,
  frozenAt,
  onTakeOver,
}: {
  leadName: string;
  speaker: string;
  draft: NonNullable<RunLead["draft"]>;
  frozenAt: Date | null;
  onTakeOver?: () => void;
}) {
  const who = firstNameOf(leadName) || leadName;
  const { text, startedAt: from, revealedBy: to } = draft;
  const frozenMs = frozenAt ? frozenAt.getTime() : null;
  const at = (now: Date) => revealed(text, new Date(from), new Date(to), now);
  const [shown, setShown] = useState(() => at(frozenAt ?? new Date()));
  const done = shown.length >= text.length;

  useEffect(() => {
    const a = new Date(from);
    const b = new Date(to);
    setShown(revealed(text, a, b, frozenMs !== null ? new Date(frozenMs) : new Date()));
    if (frozenMs !== null) return;
    const t = setInterval(() => {
      const next = revealed(text, a, b, new Date());
      setShown(next);
      if (next.length >= text.length) clearInterval(t);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [text, from, to, frozenMs]);

  const box = (
    <span className={s.typed} data-testid="typing" aria-hidden="true">
      {withMarks(shown, draft.marks)}
      {!done && !frozenAt && <span className={s.caret} />}
    </span>
  );

  return (
    <div className={s.typing} data-frozen={frozenAt ? "" : undefined}>
      <div className={s.typingHead}>
        <AiGlyph size={16} draw={frozenAt ? undefined : "pen"} />
        <span>LUME AI is writing as {speaker}</span>
        {draft.kind === "template" && draft.templateName && (
          <span className={s.templateChip}>Approved template · {draft.templateName}</span>
        )}
      </div>
      {onTakeOver ? (
        <button
          type="button"
          className={s.typingBox}
          aria-label={`Take over ${who}: type your own message`}
          onClick={onTakeOver}
        >
          {box}
        </button>
      ) : (
        <div className={s.typingBox}>{box}</div>
      )}
      {/* Outside the button: its name is the action, this is the message. */}
      <p className={s.srOnly}>
        LUME AI&apos;s message to {who}: {text}
      </p>
      {onTakeOver && <p className={s.typingHint}>Click the message to take over this lead</p>}
    </div>
  );
}
