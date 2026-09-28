"use client";
import Link from "next/link";
import { useState } from "react";
import type { WorkingHours } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { api } from "@/lib/api";
import { hoursInWords } from "@/lib/settings/hours";
import s from "./settings.module.css";

export type FollowUpConfig = {
  escalation: { enabled: boolean; hours: number };
  /** The morning email for the whole business (an optional module; on unless switched off). */
  digest?: { enabled: boolean };
  /** Leads gone quiet (3C): a follow-up for the owner after this many days without contact. */
  noTouch?: { enabled: boolean; days: number };
  /** Follow-ups LUME sets itself land inside working hours (3C). */
  shiftToWorkingHours?: boolean;
};

/**
 * Settings → Follow-ups (3B, 3C): when an overdue follow-up reaches the people who manage its assignee,
 * the morning email, leads that have gone quiet, and keeping LUME's own follow-ups to working hours.
 */
export function FollowUpSettings({
  initial,
  workingHours,
  weekStart = 1,
}: {
  initial: FollowUpConfig;
  workingHours?: WorkingHours;
  weekStart?: number;
}) {
  const [enabled, setEnabled] = useState(initial.escalation.enabled);
  const [hours, setHours] = useState(String(initial.escalation.hours));
  const [digest, setDigest] = useState(initial.digest?.enabled ?? true);
  const [quiet, setQuiet] = useState(initial.noTouch?.enabled ?? false);
  const [quietDays, setQuietDays] = useState(String(initial.noTouch?.days ?? 7));
  const [shift, setShift] = useState(initial.shiftToWorkingHours ?? true);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const n = Number(hours);
    if (!Number.isInteger(n) || n < 1 || n > 168)
      return setProblem("Choose a whole number of hours between 1 and 168 (a week).");
    const d = Number(quietDays);
    if (!Number.isInteger(d) || d < 1 || d > 90)
      return setProblem("Choose a whole number of days between 1 and 90 for leads gone quiet.");
    setBusy(true);
    setProblem(null);
    const r = await api.put<FollowUpConfig>("/api/v1/settings/follow-ups", {
      escalation: { enabled, hours: n },
      digest: { enabled: digest },
      noTouch: { enabled: quiet, days: d },
      shiftToWorkingHours: shift,
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
      <div className={s.panelHead}>
        <h2 className={s.panelTitle}>Morning emails</h2>
        <p className={s.muted}>
          Each person&apos;s day ahead, at the time they choose in My account: first names and times only.
          Switched off here, nobody gets one.
        </p>
      </div>
      <div className={s.panelBody}>
        <Switch
          checked={digest}
          onChange={(v) => {
            setDigest(v);
            setStatus(null);
          }}
          label="Send the morning email"
        />
      </div>
      <div className={s.panelHead}>
        <h2 className={s.panelTitle}>Leads gone quiet</h2>
        <p className={s.muted}>
          A lead in an open stage that nobody has touched for a while comes back to its owner as a follow-up.
          Never for a lead that already has one.
        </p>
      </div>
      <div className={s.panelBody}>
        <Switch
          checked={quiet}
          onChange={(v) => {
            setQuiet(v);
            setStatus(null);
          }}
          label="Bring back leads that have gone quiet"
        />
        <Field label="After how many days" hint="With no call, message, note or move. 7 is a week.">
          {(control) => (
            <input
              {...control}
              type="number"
              inputMode="numeric"
              min={1}
              max={90}
              step={1}
              disabled={!quiet}
              value={quietDays}
              onChange={(e) => {
                setQuietDays(e.target.value);
                setStatus(null);
              }}
            />
          )}
        </Field>
      </div>
      <div className={s.panelHead}>
        <h2 className={s.panelTitle}>Working hours</h2>
        <p className={s.muted}>
          Follow-ups LUME sets on its own (from a stage, or for a lead gone quiet) wait for the next working
          hour instead of landing at night or on a day off.
        </p>
      </div>
      <div className={s.panelBody}>
        <Switch
          checked={shift}
          onChange={(v) => {
            setShift(v);
            setStatus(null);
          }}
          label="Keep LUME's follow-ups inside working hours"
        />
        {workingHours && (
          <p className={s.muted}>
            <span>{hoursInWords(workingHours, weekStart)}</span>.{" "}
            <Link href="/settings/business">Change them in Business</Link>
          </p>
        )}
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
