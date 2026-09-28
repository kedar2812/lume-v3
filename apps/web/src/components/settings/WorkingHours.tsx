"use client";
import { useState } from "react";
import { workingHoursSchema, type WorkingHours as Hours } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { DAY_NAMES, weekFrom } from "@/lib/settings/hours";
import s from "./settings.module.css";

/**
 * Settings → Business → Working hours (3C; report §10.2): the business's week, in its own timezone.
 * Follow-ups LUME sets itself land inside it. Refused in LUME's words before the server is asked.
 */
export function WorkingHours({
  initial,
  weekStart,
  timezone,
}: {
  initial: Hours;
  weekStart: number;
  timezone: string;
}) {
  const [days, setDays] = useState<number[]>(initial.days);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const touched = () => {
    setSaved(false);
    setProblem(null);
  };

  const save = async () => {
    const parsed = workingHoursSchema.safeParse({ days: [...days].sort((a, b) => a - b), start, end });
    if (!parsed.success) return setProblem(parsed.error.issues[0]?.message ?? "Those hours aren't right.");
    setBusy(true);
    const r = await api.patch("/api/v1/settings", { workingHours: parsed.data });
    setBusy(false);
    if (!r.ok) return setProblem(r.message || "The working hours couldn't be saved.");
    setSaved(true);
  };

  return (
    <form
      className={s.panel}
      aria-labelledby="working-hours"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className={s.panelHead}>
        <h2 id="working-hours" className={s.panelTitle}>
          Working hours
        </h2>
        <p className={s.muted}>
          When your business is open, in {timezone}. Follow-ups LUME sets on its own land inside these hours.
        </p>
      </div>
      <div className={s.panelBody}>
        <fieldset className={s.dayPills}>
          <legend className={s.srOnly}>Working days</legend>
          {weekFrom(weekStart).map((d) => {
            const on = days.includes(d);
            return (
              <label key={d} className={s.dayPill} data-on={on || undefined}>
                <input
                  type="checkbox"
                  aria-label={DAY_NAMES[d]}
                  checked={on}
                  onChange={(e) => {
                    setDays((cur) => (e.target.checked ? [...cur, d] : cur.filter((x) => x !== d)));
                    touched();
                  }}
                />
                <span aria-hidden>{DAY_NAMES[d]!.slice(0, 3)}</span>
              </label>
            );
          })}
        </fieldset>
        <div className={s.hoursRow}>
          <label className={s.ruleField}>
            <span>From</span>
            <input
              type="time"
              aria-label="From"
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                touched();
              }}
            />
          </label>
          <label className={s.ruleField}>
            <span>Until</span>
            <input
              type="time"
              aria-label="Until"
              value={end}
              onChange={(e) => {
                setEnd(e.target.value);
                touched();
              }}
            />
          </label>
        </div>
      </div>
      <div className={s.panelFoot}>
        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}
        {saved && (
          <p role="status" className={s.saved}>
            Saved
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy} aria-label="Save working hours">
          Save
        </Button>
      </div>
    </form>
  );
}
