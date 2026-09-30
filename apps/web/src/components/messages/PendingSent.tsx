"use client";
import { useEffect, useRef, useState } from "react";
import { useSound } from "@/components/feedback/SoundProvider";
import { leadsClient } from "@/lib/leads/client";
import { onBack, type Pending } from "@/lib/messages/pending";
import { SentPrompt, type Outcome } from "./SentPrompt";
import s from "./messages.module.css";

/**
 * "Sent?" for a WhatsApp opened from a sheet that has gone since (the drawer stepped on with J/K, the
 * notification centre closed): the shell asks, naming the lead, and answers as the sheet would have.
 */
export function PendingSent() {
  const sound = useSound();
  const [p, setP] = useState<Pending | null>(null);
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const answered = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () =>
      onBack((x, bySheet) => {
        if (bySheet) return;
        clearTimeout(timer.current);
        answered.current = false;
        setP(x);
        setOutcome(null);
        setAsking(true);
      }),
    [],
  );
  useEffect(() => () => clearTimeout(timer.current), []);

  const done = (after: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setOutcome(null);
      setP(null);
    }, after);
  };
  const answer = async (sent: boolean) => {
    if (!p || answered.current) return;
    answered.current = true;
    setAsking(false);
    if (sent) setOutcome({ pending: true });
    const r = await leadsClient.confirmMessage(p.leadId, sent, p.taskId);
    if (!sent) return setP(null);
    if (!r.ok) {
      setOutcome({ failed: r.message });
      return done(6000);
    }
    sound.play("sent");
    const said: Outcome = r.data.moved
      ? { moved: r.data.moved }
      : r.data.notMoved
        ? { refused: r.data.notMoved.message }
        : {};
    setOutcome(said);
    done(said.moved || said.refused ? 6000 : 1600);
  };
  const undo = async () => {
    const moved = outcome?.moved;
    if (!p || !moved) return;
    const r = await leadsClient.move(p.leadId, moved.fromStageId);
    setOutcome(r.ok ? { moved, undone: true } : { failed: r.message });
    done(r.ok ? 1400 : 6000);
  };

  if (!p) return null;
  return (
    <div className={s.pendingHost}>
      <span className={s.srOnly} aria-live="polite">
        {asking ? `Back from WhatsApp. Was the message to ${p.leadName} sent?` : ""}
      </span>
      <SentPrompt
        asking={asking}
        outcome={outcome}
        leadName={p.leadName}
        onAnswer={(sent) => void answer(sent)}
        onUndo={() => void undo()}
      />
    </div>
  );
}
