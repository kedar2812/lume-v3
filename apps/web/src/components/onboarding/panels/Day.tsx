import type { Preferences } from "@lume/core/shared";
import { Field } from "@/components/ui/Field";
import { DAY_CHIPS, dayPreview } from "@/lib/day-preview";
import s from "../onboarding.module.css";
import { PanelHead } from "./Head";

type Day = Pick<Preferences, "workingDays" | "workStart" | "workEnd" | "digestTime">;

export function DayPanel({
  kicker,
  value,
  onChange,
}: {
  kicker: string;
  value: Day;
  onChange: (d: Day) => void;
}) {
  const toggle = (day: number) =>
    onChange({
      ...value,
      workingDays: value.workingDays.includes(day)
        ? value.workingDays.filter((d) => d !== day)
        : [...value.workingDays, day].sort((a, b) => a - b),
    });
  const time = (key: "workStart" | "workEnd" | "digestTime") => (e: { target: { value: string } }) =>
    e.target.value && onChange({ ...value, [key]: e.target.value });

  return (
    <>
      <PanelHead
        kicker={kicker}
        title="Your working day"
        lead="LUME keeps reminders inside your hours and sends you one summary each morning."
      />
      <div className={s.form}>
        <div>
          <p className={s.label} id="days-label">
            Days you work
          </p>
          <div className={s.days} role="group" aria-labelledby="days-label">
            {DAY_CHIPS.map((c) => (
              <button
                key={c.day}
                type="button"
                className={s.day}
                aria-pressed={value.workingDays.includes(c.day)}
                onClick={() => toggle(c.day)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <div className={s.two}>
          <Field label="From">
            {(control) => (
              <input {...control} type="time" value={value.workStart} onChange={time("workStart")} />
            )}
          </Field>
          <Field label="To">
            {(control) => <input {...control} type="time" value={value.workEnd} onChange={time("workEnd")} />}
          </Field>
        </div>
        <Field label="Morning digest">
          {(control) => (
            <input {...control} type="time" value={value.digestTime} onChange={time("digestTime")} />
          )}
        </Field>
      </div>
      <p className={s.previewLine} data-testid="day-preview" aria-live="polite">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M8 4.8V8l2.2 1.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <span>{dayPreview(value.workingDays, value.workStart, value.workEnd, value.digestTime)}</span>
      </p>
    </>
  );
}
