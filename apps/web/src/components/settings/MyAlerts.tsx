"use client";
import { useRef, useState } from "react";
import type { Preferences } from "@lume/core/shared";
import { Field } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { api } from "@/lib/api";
import s from "./settings.module.css";

type Alerts = Preferences["alerts"];
const SWITCHES: { key: keyof Alerts; label: string; hint: string }[] = [
  { key: "dueFollowUps", label: "Follow-ups due", hint: "A reminder at the time you chose, and before it." },
  { key: "assigned", label: "Given to me", hint: "When someone gives you a lead or a follow-up." },
  {
    key: "emailDigest",
    label: "Morning email",
    hint: "Your day ahead, on your working days. First names and times only.",
  },
];

/**
 * My account → Notifications (3B): what reaches you, in the app and by email. Each switch saves the
 * moment it's flipped. Your follow-ups stay on Today whatever you choose here.
 */
export function MyAlerts({ initial }: { initial: Preferences }) {
  const [alerts, setAlerts] = useState<Alerts>(initial.alerts);
  const [digestTime, setDigestTime] = useState(initial.digestTime);
  const savedTime = useRef(initial.digestTime); // what LUME last kept, so changing it back saves too
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (preferences: Record<string, unknown>) => {
    setProblem(null);
    const r = await api.patch("/api/v1/me", { preferences });
    if (!r.ok) setProblem(r.message);
    return r.ok;
  };
  const flip = async (key: keyof Alerts, on: boolean) => {
    setAlerts((a) => ({ ...a, [key]: on }));
    if (!(await save({ alerts: { [key]: on } }))) setAlerts((a) => ({ ...a, [key]: !on }));
  };

  return (
    <section className={s.panel} aria-labelledby="acct-notifications">
      <div className={s.panelHead}>
        <h2 id="acct-notifications" className={s.panelTitle}>
          Notifications
        </h2>
        <p className={s.muted}>
          What LUME tells you, and when. Your follow-ups stay on Today whatever you choose.
        </p>
      </div>
      <div className={s.panelBody}>
        {SWITCHES.map((x) => (
          <div key={x.key} className={s.switchRow}>
            <Switch checked={alerts[x.key]} onChange={(v) => void flip(x.key, v)} label={x.label} />
            <p className={s.muted}>{x.hint}</p>
          </div>
        ))}
        <Field label="Send it at" hint="In your own timezone.">
          {(control) => (
            <input
              {...control}
              type="time"
              disabled={!alerts.emailDigest}
              value={digestTime}
              onChange={(e) => setDigestTime(e.target.value)}
              onBlur={() => {
                if (!/^\d{2}:\d{2}$/.test(digestTime) || digestTime === savedTime.current) return;
                const time = digestTime;
                void save({ digestTime: time }).then((ok) => ok && (savedTime.current = time));
              }}
            />
          )}
        </Field>
        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}
      </div>
    </section>
  );
}
