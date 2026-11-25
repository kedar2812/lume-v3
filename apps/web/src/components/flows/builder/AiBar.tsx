"use client";
import { useLayoutEffect, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import s from "./builder.module.css";

/** Where a build is: nothing asked, LUME AI thinking, its steps landing, or landed and waiting for Keep or Discard. */
export type AiPhase = "idle" | "asking" | "playing" | "done";

/** The API's limit on the words (C1). */
const MAX_WORDS = 2000;
/** Stop, Keep and Discard wait this long after they appear: a double click on Build it never stops the build. */
export const ARM_MS = 400;

type Props = {
  phase: AiPhase;
  prompt: string;
  onPrompt: (v: string) => void;
  /** Steps are selected: only they go, and the words say so. */
  selecting: boolean;
  /** "LUME AI built 3 steps." once it's done. */
  doneWords: string;
  /** A side panel is open: the bar sits in the middle of what's left. */
  beside: boolean;
  /** Some steps are marked New. */
  marked: boolean;
  onBuild: () => void;
  onStop: () => void;
  onKeep: () => void;
  onDiscard: () => void;
};

/**
 * LUME AI's bar at the foot of the canvas (plan 2026-11-23-flow-builder, Task C2; approved canvas, board Builder): the
 * words, then what it's doing, then Keep or Discard.
 */
export function AiBar(p: Props) {
  const label = p.selecting
    ? "Tell LUME AI what to change in the selected steps"
    : "Tell LUME AI what this flow should do";
  const busy = p.phase === "asking" || p.phase === "playing";
  // Ready for a press only once these buttons have been on screen a moment: Stop stays ready from asking to playing.
  const buttons = busy ? "stop" : p.phase;
  const [armed, setArmed] = useState(false);
  useLayoutEffect(() => {
    setArmed(false);
    const t = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(t);
  }, [buttons]);
  return (
    <div className={s.aibar} data-beside={p.beside || undefined} data-tool>
      <AiGlyph size={22} className={s.aiLoop} {...(busy ? { draw: "pen" as const } : {})} />
      {p.phase === "idle" ? (
        <form
          className={s.aiForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (p.prompt.trim()) p.onBuild();
          }}
        >
          <input
            className={s.aiInput}
            aria-label={label}
            placeholder={label}
            value={p.prompt}
            maxLength={MAX_WORDS}
            onChange={(e) => p.onPrompt(e.target.value)}
          />
          <button type="submit" className={s.aiGo} disabled={!p.prompt.trim()}>
            Build it
          </button>
        </form>
      ) : p.phase === "done" ? (
        <>
          <span className={s.aiSay}>
            <b>{p.doneWords}</b>
            {p.marked && " They're marked New until you keep them."}
          </span>
          <button type="button" className={s.aiGhost} disabled={!armed} onClick={p.onDiscard}>
            Discard
          </button>
          <button type="button" className={s.aiGo} disabled={!armed} onClick={p.onKeep}>
            Keep
          </button>
        </>
      ) : (
        <>
          <span className={s.aiSay} role="status">
            <b>LUME AI is building.</b> Each step lands on the canvas as it goes.
          </span>
          <button type="button" className={s.aiBtn} disabled={!armed} onClick={p.onStop}>
            Stop
          </button>
        </>
      )}
    </div>
  );
}
