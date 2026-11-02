"use client";
import { firstNameOf } from "@lume/core/shared";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { leadsClient } from "@/lib/leads/client";
import s from "./drawer.module.css";

export type DoNotContactView = { at: string; by: string | null; reason: string | null };

/**
 * A lead who asked not to be messaged, said on the lead with why (owner 2026-11-02: the message said "an admin can lift
 * this on the lead", and there was nothing there to lift it with). Only an admin lifts it, after a word on what it means.
 */
export function DoNotContact({
  leadId,
  leadName,
  value,
  canLift,
  onLifted,
}: {
  leadId: string;
  leadName: string;
  value: DoNotContactView;
  /** An admin (settings.manage), as the server asks. */
  canLift: boolean;
  onLifted(): void;
}) {
  const who = firstNameOf(leadName) || "This lead";
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lift = async () => {
    setBusy(true);
    setError(null);
    const r = await leadsClient.liftDoNotContact(leadId);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setAsking(false);
    onLifted();
  };

  return (
    <section className={s.dnc} role="status" aria-label="Do not contact">
      <p className={s.dncTitle}>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3.6 12.4 12.4 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        {who} asked not to be messaged
      </p>
      {value.reason && <p className={s.dncWhy}>{value.reason}</p>}
      {!canLift ? (
        <p className={s.dncWhy}>An admin can lift this.</p>
      ) : asking ? (
        <div className={s.dncAsk}>
          <p>
            Only lift this if {who} asked to hear from you again. LUME, LUME AI and your team can message{" "}
            {who} once it&apos;s lifted.
          </p>
          {error && (
            <p role="alert" className={s.dncError}>
              {error}
            </p>
          )}
          <div className={s.dncActions}>
            <Button size="sm" onClick={() => setAsking(false)} disabled={busy}>
              Keep it
            </Button>
            <Button size="sm" variant="danger" loading={busy} onClick={() => void lift()}>
              Lift it
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" onClick={() => setAsking(true)}>
          Lift do not contact
        </Button>
      )}
    </section>
  );
}
