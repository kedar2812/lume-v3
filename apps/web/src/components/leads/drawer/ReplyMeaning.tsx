"use client";
import { REPLY_MEANING_WORDS } from "@lume/core/shared";
import { useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { Button } from "@/components/ui/Button";
import { aiClient } from "@/lib/ai/client";
import { appliedWords, dueWords } from "@/lib/ai/words";
import type { WaMeaning } from "@/lib/whatsapp/types";
import s from "./reply-meaning.module.css";

/** How a group reads at a glance: good news, something to answer, or a no. */
const TONE: Record<WaMeaning["group"], "ok" | "ask" | "no" | "plain"> = {
  interested: "ok",
  price: "ask",
  visit_or_call: "ok",
  later: "plain",
  not_interested: "no",
  stop: "no",
  wrong_number: "no",
  not_sure: "plain",
};

/**
 * What a lead's WhatsApp reply means, under it (W2, spec 2026-10-18 §5.1, §5.4): its group and line, where it came from,
 * and the next step LUME AI suggests from the business's own lists, done only when the person taps Apply. A stop says
 * LUME marked the lead do not contact (that's the one thing applied without a tap); a read that failed says so once.
 */
export function ReplyMeaning({
  meaning,
  from,
  tz,
  onDone,
}: {
  meaning: WaMeaning | { failed: true };
  /** The lead's first name. */
  from: string;
  tz: string;
  /** Something was applied: the thread and the lead are read again. */
  onDone(): void;
}) {
  const [outcome, setOutcome] = useState<WaMeaning["outcome"]>("failed" in meaning ? null : meaning.outcome);
  const [said, setSaid] = useState<{ done: string | null; skipped: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if ("failed" in meaning) return <p className={s.failed}>LUME AI couldn&apos;t read this reply.</p>;

  const m = meaning;
  const stage = m.stageName ? (m.lostReason ? `${m.stageName} · ${m.lostReason}` : m.stageName) : null;
  const when = m.dueAt ? dueWords(m.dueAt, tz) : null;
  const offered = !m.stop && (stage || when);
  const apply = async () => {
    setBusy(true);
    setProblem(null);
    const r = await aiClient.apply(m.readId, { stage: !!stage, followUp: !!when, tags: false });
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    setOutcome("applied");
    setSaid(appliedWords(r.data, { stage, when, tags: [] }));
    onDone();
  };
  const dismiss = async () => {
    setBusy(true);
    const r = await aiClient.dismiss(m.readId);
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    setOutcome("dismissed");
  };

  return (
    <div className={s.meaning} aria-label={`What ${from}'s reply means`} role="group">
      <div className={s.head}>
        <span className={s.chip} data-tone={TONE[m.group]}>
          {REPLY_MEANING_WORDS[m.group]}
        </span>
        <span className={s.summary}>{m.summary}</span>
      </div>
      {m.stop ? (
        <p className={s.line}>LUME marked {from} do not contact.</p>
      ) : (
        offered &&
        outcome !== "dismissed" && (
          <div className={s.step}>
            <p className={s.from}>
              <AiGlyph size={12} />
              From {from}&apos;s reply
            </p>
            <ul className={s.parts}>
              {stage && <li>Move to {stage}</li>}
              {when && <li>Follow up {when}</li>}
            </ul>
            {said ? (
              <p className={s.line} role="status">
                {said.done}
                {said.skipped.map((x) => ` ${x}`)}
              </p>
            ) : outcome === "applied" ? (
              <p className={s.line}>Applied</p>
            ) : (
              <div className={s.actions}>
                <Button size="sm" variant="primary" onClick={() => void apply()} disabled={busy}>
                  Apply
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void dismiss()} disabled={busy}>
                  Dismiss
                </Button>
              </div>
            )}
            {problem && (
              <p className={s.problem} role="alert">
                {problem}
              </p>
            )}
          </div>
        )
      )}
    </div>
  );
}
