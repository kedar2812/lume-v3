"use client";
import { useId, type ReactNode } from "react";
import type { Preferences } from "@lume/core/shared";
import s from "../onboarding.module.css";
import { PanelHead } from "./Head";

type Alerts = Pick<Preferences, "sounds" | "alerts">;

/** A labelled row with a switch whose accessible name is the row's title. */
function Row({
  title,
  detail,
  checked,
  onChange,
  children,
}: {
  title: string;
  detail: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={s.set}>
      <div className={s.setText}>
        <b id={id}>{title}</b>
        <span>{detail}</span>
      </div>
      {children}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        className={s.toggle}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export function AlertsPanel({
  kicker,
  value,
  onChange,
  onSample,
  isAdmin,
}: {
  kicker: string;
  value: Alerts;
  onChange: (v: Alerts) => void;
  onSample: (volume: number) => void;
  isAdmin: boolean;
}) {
  const alert = (key: keyof Preferences["alerts"]) => (v: boolean) =>
    onChange({ ...value, alerts: { ...value.alerts, [key]: v } });
  return (
    <>
      <PanelHead
        kicker={kicker}
        title="Alerts and sounds"
        lead="LUME only makes a sound when you achieve something, like winning a lead or clearing your list. Never for clicks."
      />
      <div className={s.card}>
        <Row
          title="Achievement sounds"
          detail="A soft chime for wins and cleared lists"
          checked={value.sounds.enabled}
          onChange={(enabled) => onChange({ ...value, sounds: { ...value.sounds, enabled } })}
        >
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            aria-label="Sound volume"
            className={s.range}
            disabled={!value.sounds.enabled}
            value={value.sounds.volume}
            onChange={(e) =>
              onChange({ ...value, sounds: { ...value.sounds, volume: Number(e.target.value) } })
            }
          />
          <button
            type="button"
            className={s.play}
            aria-label="Play a sample"
            disabled={!value.sounds.enabled || value.sounds.volume === 0}
            onClick={() => onSample(value.sounds.volume)}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
              <path d="M3 2.2v7.6L9.6 6z" fill="currentColor" />
            </svg>
          </button>
        </Row>
        <Row
          title="A lead is assigned to me"
          detail="In LUME, and in your morning digest"
          checked={value.alerts.assigned}
          onChange={alert("assigned")}
        />
        <Row
          title="Follow-ups due or overdue"
          detail="In LUME, with a reminder when it’s time"
          checked={value.alerts.dueFollowUps}
          onChange={alert("dueFollowUps")}
        />
        <Row
          title="Email me the morning digest"
          detail="One email a day, never lead contact details"
          checked={value.alerts.emailDigest}
          onChange={alert("emailDigest")}
        />
        {isAdmin && (
          <div className={s.set}>
            <div className={s.setText}>
              <b>Security alerts</b>
              <span>Emails about locked accounts and other security events</span>
            </div>
            <span className={s.always}>Always on for admins</span>
          </div>
        )}
      </div>
    </>
  );
}
