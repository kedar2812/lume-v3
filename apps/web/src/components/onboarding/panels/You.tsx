"use client";
import { useEffect, useState } from "react";
import { Field } from "@/components/ui/Field";
import { TimezonePicker } from "@/components/ui/TimezonePicker";
import { localTime } from "@/lib/timezones";
import s from "../onboarding.module.css";
import { PanelHead } from "./Head";

export function YouPanel({
  kicker,
  name,
  onName,
  timezone,
  onTimezone,
  invited,
}: {
  kicker: string;
  name: string;
  onName: (v: string) => void;
  timezone: string;
  onTimezone: (v: string) => void;
  invited: boolean;
}) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 20_000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <PanelHead
        kicker={kicker}
        title="First, about you"
        lead="Your timezone decides when your “today” starts, when reminders ring and when your digest arrives."
      />
      <div className={s.form}>
        <Field
          label="Your name"
          hint={invited ? "Entered when you were invited. Change it if it’s not quite right." : undefined}
        >
          {(control) => (
            <input {...control} autoComplete="name" value={name} onChange={(e) => onName(e.target.value)} />
          )}
        </Field>
        <div>
          <Field label="Timezone">
            {(control) => <TimezonePicker control={control} value={timezone} onChange={onTimezone} />}
          </Field>
          {now && timezone && (
            <p className={s.clock}>
              It’s <b>{localTime(timezone, now)}</b> for you right now
            </p>
          )}
        </div>
      </div>
    </>
  );
}
