"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { api } from "@/lib/api";
import s from "./settings.module.css";

export type MessagingConfig = { queueSize: number; dailyCap: number };

/**
 * Settings → Messages (4C): how many leads a send-queue run holds, and how many queued messages each
 * person may send in a day. Single messages from a lead's drawer never count towards the limit.
 */
export function MessagingSettings({ initial }: { initial: MessagingConfig }) {
  const [size, setSize] = useState(String(initial.queueSize));
  const [cap, setCap] = useState(String(initial.dailyCap));
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const n = Number(size);
    if (!Number.isInteger(n) || n < 1 || n > 200) return setProblem("Choose a run of 1 to 200 leads.");
    const c = Number(cap);
    if (!Number.isInteger(c) || c < 1 || c > 500)
      return setProblem("Choose a daily limit between 1 and 500.");
    setBusy(true);
    setProblem(null);
    const r = await api.put<MessagingConfig>("/api/v1/settings/messaging", { queueSize: n, dailyCap: c });
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    setStatus("Saved");
  };

  return (
    <form
      className={s.panel}
      noValidate // LUME says what's wrong in its own words, not the browser's bubble
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className={s.panelHead}>
        <h2 className={s.panelTitle}>The send queue</h2>
        <p className={s.muted}>
          Messaging many leads is one run: LUME shows each in turn, you send, and it moves on. A run takes up
          to this many leads from a view or a selection.
        </p>
      </div>
      <div className={s.panelBody}>
        <Field label="Leads in a run" hint="1 to 200. Fifty is a comfortable sitting.">
          {(control) => (
            <input
              {...control}
              type="number"
              inputMode="numeric"
              min={1}
              max={200}
              step={1}
              value={size}
              onChange={(e) => {
                setSize(e.target.value);
                setStatus(null);
              }}
            />
          )}
        </Field>
      </div>
      <div className={s.panelHead}>
        <h2 className={s.panelTitle}>A daily limit</h2>
        <p className={s.muted}>
          Each person&apos;s runs pause once they&apos;ve sent this many in their day, and pick up again
          tomorrow. It keeps a number from looking like a spammer&apos;s to WhatsApp. Single messages from a
          lead never count.
        </p>
      </div>
      <div className={s.panelBody}>
        <Field label="Queued messages a person may send a day" hint="1 to 500.">
          {(control) => (
            <input
              {...control}
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              step={1}
              value={cap}
              onChange={(e) => {
                setCap(e.target.value);
                setStatus(null);
              }}
            />
          )}
        </Field>
      </div>
      <div className={s.panelFoot}>
        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}
        {status && !problem && (
          <p role="status" className={s.saved}>
            {status}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
