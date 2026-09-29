"use client";
import { useIsPresent } from "motion/react";
import { useEffect, useId, useState } from "react";
import { SentPrompt, type Outcome } from "@/components/messages/SentPrompt";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { queuesClient, type QueueItem } from "@/lib/queues/client";
import s from "./run.module.css";

/** Where a lead's card is: ready to send, WhatsApp open, asking Sent?, saving the answer, or sent. */
export type CardPhase = "ready" | "away" | "asking" | "answering" | "sent";

/**
 * One lead of the run: who, where they are, why they're here, and the message in their words (editable for
 * this lead only). Send (green, Enter) and Skip (S); back from WhatsApp, Sent? sits in the card.
 */
export function QueueCard({
  runId,
  item,
  sourceName,
  phase,
  note,
  outcome,
  onSend,
  onSkip,
  onAnswer,
}: {
  runId: string;
  item: QueueItem;
  sourceName: string;
  phase: CardPhase;
  /** Why this lead can't be sent (skipped at send time), shown for a moment before the next comes. */
  note: string | null;
  outcome: { moved?: string; refused?: string } | null;
  onSend: (text: string | undefined) => void;
  onSkip: () => void;
  onAnswer: (sent: boolean) => void;
}) {
  const id = useId();
  // Leaving (sliding out as the next comes in): nothing on it can be pressed, typed or found by a key.
  const present = useIsPresent();
  const [text, setText] = useState("");
  const [original, setOriginal] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void queuesClient.text(runId, item.position).then((r) => {
      if (!live || !r.ok) return;
      if ("unavailable" in r.data) return setUnavailable(r.data.unavailable);
      setText(r.data.text);
      setOriginal(r.data.text);
    });
    return () => {
      live = false;
    };
  }, [runId, item.position]);

  const said: Outcome | null =
    phase === "answering"
      ? { pending: true }
      : phase === "sent" && outcome
        ? {
            ...(outcome.moved
              ? { moved: { stageId: "", stageName: outcome.moved, fromStageId: "", undoable: false } }
              : {}),
            ...(outcome.refused ? { refused: outcome.refused } : {}),
          }
        : null;
  const ready = phase === "ready" && !note;
  const why = note ?? unavailable;
  return (
    <form
      data-queue-form={present ? "" : undefined}
      inert={!present}
      aria-hidden={present ? undefined : true}
      className={s.card}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        // A lead that can't be sent: Enter (and the primary) skips it, with its reason.
        if (unavailable) return onSkip();
        if (!text.trim()) return;
        // Unchanged, the server sends the version the run planned with; changed, these words.
        onSend(text === original ? undefined : text);
      }}
    >
      <div className={s.who}>
        <h2 className={s.name}>{item.name}</h2>
        <p className={s.meta}>
          {item.stageName && <span className={s.stageChip}>{item.stageName}</span>}
          <span className={s.from}>
            From <span>{sourceName}</span>
          </span>
        </p>
      </div>

      {!unavailable && (
        <>
          <label htmlFor={`${id}-text`} className={s.label}>
            Message
          </label>
          <textarea
            id={`${id}-text`}
            className={s.text}
            rows={6}
            maxLength={4096}
            value={text}
            disabled={!ready}
            placeholder={original === "" ? `Hi ${item.name.split(" ")[0] ?? ""},` : undefined}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </>
      )}

      {why && (
        <p role="status" className={s.note}>
          {why}
        </p>
      )}
      {phase === "away" && (
        <p role="status" className={s.away}>
          WhatsApp is open. Come back here once it&apos;s sent.
        </p>
      )}
      <SentPrompt
        asking={phase === "asking"}
        outcome={said}
        inline
        onAnswer={onAnswer}
        onUndo={() => undefined}
      />

      {(phase === "ready" || phase === "away") && (
        <div className={s.actions}>
          {unavailable ? (
            <Button type="submit" variant="primary" disabled={!ready}>
              Skip
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={onSkip} disabled={phase !== "ready" || !!note}>
                Skip
              </Button>
              <Button type="submit" variant="whatsapp" disabled={!ready || !text.trim()}>
                Send
              </Button>
            </>
          )}
        </div>
      )}
      <p className={s.keys} aria-hidden>
        {phase === "asking" ? (
          <>
            <Kbd>Y</Kbd> Yes · <Kbd>N</Kbd> Not sent
          </>
        ) : (
          <>
            {unavailable ? (
              <>
                <Kbd>↵</Kbd> Skip · <Kbd>P</Kbd> Pause · <Kbd>Esc</Kbd> Leave
              </>
            ) : (
              <>
                <Kbd>↵</Kbd> Send · <Kbd>S</Kbd> Skip · <Kbd>P</Kbd> Pause · <Kbd>Esc</Kbd> Leave
              </>
            )}
          </>
        )}
      </p>
    </form>
  );
}
