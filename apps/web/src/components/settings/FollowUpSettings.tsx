"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { api } from "@/lib/api";
import s from "./settings.module.css";

export type FollowUpConfig = { escalation: { enabled: boolean; hours: number } };

/**
 * Settings → Follow-ups (3B): when a follow-up is left overdue, how long before it reaches the people who
 * manage its assignee (the team lead, and anyone who manages everyone's follow-ups).
 */
export function FollowUpSettings({ initial }: { initial: FollowUpConfig }) {
  const [enabled, setEnabled] = useState(initial.escalation.enabled);
  const [hours, setHours] = useState(String(initial.escalation.hours));
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const n = Number(hours);
    if (!Number.isInteger(n) || n < 1 || n > 168)
      return setProblem("Choose a whole number of hours between 1 and 168 (a week).");
    setBusy(true);
    setProblem(null);
    const r = await api.put<FollowUpConfig>("/api/v1/settings/follow-ups", {
      escalation: { enabled, hours: n },
    });
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
        <h2 className={s.panelTitle}>Overdue follow-ups</h2>
        <p className={s.muted}>
          When someone&apos;s follow-up is left overdue, LUME tells the people who manage them: their team
          lead, and anyone who manages everyone&apos;s follow-ups. Once for each follow-up.
        </p>
      </div>
      <div className={s.panelBody}>
        <Switch
          checked={enabled}
          onChange={(v) => {
            setEnabled(v);
            setStatus(null);
          }}
          label="Tell managers about overdue follow-ups"
        />
        <Field label="After how many hours" hint="Counted from the time it was due. 24 is a day.">
          {(control) => (
            <input
              {...control}
              type="number"
              inputMode="numeric"
              min={1}
              max={168}
              step={1}
              disabled={!enabled}
              value={hours}
              onChange={(e) => {
                setHours(e.target.value);
                setStatus(null);
              }}
            />
          )}
        </Field>
      </div>
      <div className={s.panelFoot}>
        {status && (
          <p role="status" className={s.saved}>
            {status}
          </p>
        )}
        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
