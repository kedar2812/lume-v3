"use client";
import type { CallRules } from "@lume/core/shared";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import s from "./ai.module.css";

/**
 * LUME makes the Meet link (spec 2026-11-03), where Google Calendar is set up here: the person's own calendar, and the
 * way to let LUME add calls to it (saves the page first, then Google's consent; resolves with why not, if it couldn't).
 */
export type MeetSetup = {
  mine: { googleEmail: string; addsEvents: boolean; status: "active" | "needs_reconnect" } | null;
  allow(): Promise<string | null>;
};

/** Monday first, as a week reads; 0 is Sunday, as LUME stores days. */
const WEEK = [
  { d: 1, name: "Monday" },
  { d: 2, name: "Tuesday" },
  { d: 3, name: "Wednesday" },
  { d: 4, name: "Thursday" },
  { d: 5, name: "Friday" },
  { d: 6, name: "Saturday" },
  { d: 0, name: "Sunday" },
];
const MINUTES = ["15", "30", "45", "60"] as const;
const X = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M7 7l10 10M17 7L7 17" />
  </svg>
);

/**
 * Settings → LUME AI, the calls LUME AI may say yes to (spec 2026-11-02): rows of days and a from–to on the business's
 * clock, then a call's length, the notice and how far ahead. LUME AI says yes only inside these, when the speaker is free;
 * with none, a person confirms every call a lead proposes.
 */
export function CallTimes({
  value: v,
  onChange,
  meet,
}: {
  value: CallRules;
  onChange(v: CallRules): void;
  /** Absent where Google Calendar isn't set up and on: no Meet link, the business's own words. */
  meet?: MeetSetup;
}) {
  const set = (patch: Partial<CallRules>) => onChange({ ...v, ...patch });
  const setRow = (i: number, patch: Partial<CallRules["windows"][number]>) =>
    set({ windows: v.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  const number = (text: string, apply: (n: number) => void) => {
    const n = Number(text);
    if (text !== "" && Number.isInteger(n)) apply(n);
  };

  return (
    <section className={s.block} aria-labelledby="ai-calls" id="ai-calls-block" data-whatsnew="calls">
      <h3 id="ai-calls" className={s.blockTitle}>
        Calls LUME AI may say yes to
      </h3>
      <p className={s.blockLede}>
        When a lead asks for a call at one of these times and you&apos;re free, LUME AI says yes and books it.
        With none, a person confirms every call.
      </p>
      {v.windows.map((w, i) => (
        <div key={i} role="group" aria-label={`Call times ${i + 1}`} className={s.callRow}>
          <div className={s.weekdays}>
            {WEEK.map(({ d, name }) => {
              const on = w.days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  className={s.weekday}
                  aria-label={name}
                  aria-pressed={on}
                  onClick={() =>
                    setRow(i, {
                      days: on ? w.days.filter((x) => x !== d) : [...w.days, d].sort((a, b) => a - b),
                    })
                  }
                >
                  {name.slice(0, 1)}
                </button>
              );
            })}
          </div>
          <div className={s.span}>
            <input
              type="time"
              step={900}
              className={`${s.input} ${s.time}`}
              aria-label="From"
              value={w.from}
              onChange={(e) => e.target.value && setRow(i, { from: e.target.value })}
            />
            <span aria-hidden>to</span>
            <input
              type="time"
              step={900}
              className={`${s.input} ${s.time}`}
              aria-label="To"
              aria-invalid={w.from >= w.to || undefined}
              value={w.to}
              onChange={(e) => e.target.value && setRow(i, { to: e.target.value })}
            />
          </div>
          <button
            type="button"
            className={s.remove}
            aria-label={`Remove call times ${i + 1}`}
            onClick={() => set({ windows: v.windows.filter((_, j) => j !== i) })}
          >
            {X}
          </button>
        </div>
      ))}
      <Button
        size="sm"
        disabled={v.windows.length >= 14}
        onClick={() =>
          set({
            windows: [
              ...v.windows,
              v.windows.length
                ? { days: [6], from: "10:00", to: "13:00" }
                : { days: [1, 2, 3, 4, 5], from: "10:00", to: "18:00" },
            ],
          })
        }
      >
        Add times
      </Button>
      {v.windows.length > 0 && (
        <>
          <div className={s.choice}>
            <span className={s.label}>A call is</span>
            <SegmentedControl
              size="sm"
              label="A call is"
              value={String(v.minutes) as (typeof MINUTES)[number]}
              options={MINUTES.map((m) => ({ value: m, label: `${m} min` }))}
              onChange={(m) => set({ minutes: Number(m) })}
            />
          </div>
          <div className={s.callLimits}>
            <label className={s.capNote}>
              <input
                type="number"
                min={0}
                max={72}
                inputMode="numeric"
                className={`${s.input} ${s.capInput}`}
                aria-label="Hours' notice, at least"
                value={v.noticeHours}
                onChange={(e) => number(e.target.value, (noticeHours) => set({ noticeHours }))}
              />
              hours&apos; notice, at least
            </label>
            <label className={s.capNote}>
              <input
                type="number"
                min={1}
                max={60}
                inputMode="numeric"
                className={`${s.input} ${s.capInput}`}
                aria-label="Days ahead, at most"
                value={v.daysAhead}
                onChange={(e) => number(e.target.value, (daysAhead) => set({ daysAhead }))}
              />
              days ahead, at most
            </label>
          </div>
          {meet && <MeetLink on={!!v.meet} setup={meet} onChange={(on) => set({ meet: on })} />}
          {
            <Field
              label="How the call happens"
              hint={
                meet && v.meet
                  ? "LUME AI says this when a call can't have a Meet link (the speaker hasn't allowed it). Optional."
                  : "LUME AI says this when it says yes. Optional."
              }
            >
              {(c) => (
                <input
                  {...c}
                  className={s.input}
                  maxLength={200}
                  placeholder="We'll call you on this number."
                  value={v.how}
                  onChange={(e) => set({ how: e.target.value })}
                />
              )}
            </Field>
          }
        </>
      )}
    </section>
  );
}

const TICK = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M3.5 8.4 6.6 11.3 12.5 4.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * The Meet link card: one switch, and under it the one thing left to do, if anything. The permission is Google's own
 * consent, asked only here, so nobody who leaves this off is ever asked for it.
 */
function MeetLink({ on, setup, onChange }: { on: boolean; setup: MeetSetup; onChange(on: boolean): void }) {
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const mine = setup.mine;
  const allowed = !!mine?.addsEvents && mine.status === "active";
  const allow = async () => {
    setBusy(true);
    setWhy(null);
    const r = await setup.allow();
    // Gone to Google, or back here with why not.
    setBusy(false);
    setWhy(r);
  };

  return (
    <div className={s.meet} role="group" aria-labelledby="ai-meet">
      <div className={s.meetHead}>
        <span className={s.brandTile}>
          <img src="/brand/google-meet.png" alt="" width={22} height={22} />
        </span>
        <div className={s.meetText}>
          <span id="ai-meet" className={s.meetTitle}>
            Google Meet link
          </span>
          <span className={s.meetLede}>
            Each call goes into a LUME calls calendar in your Google Calendar, with a new Meet link, and LUME
            AI sends the link to the lead.
          </span>
        </div>
        <Switch checked={on} onChange={onChange} label="LUME makes a Google Meet link" labelHidden />
      </div>
      {on &&
        (allowed ? (
          <div className={s.meetAsk}>
            <p className={s.meetOk}>
              <span className={s.meetTick}>{TICK}</span>
              LUME adds calls to LUME calls, in {mine.googleEmail}
            </p>
            <p className={s.meetNote}>
              Each person LUME AI speaks as allows this for their own calendar, here. Until they do, their
              calls use your words below.
            </p>
          </div>
        ) : (
          <div className={s.meetAsk}>
            <p className={s.meetNote}>
              {mine?.addsEvents
                ? "Your Google Calendar needs connecting again. Until then, your calls use the words below, without a Meet link."
                : "Google asks you once. LUME makes one calendar of its own and adds only the calls LUME AI books there; your other calendars stay as they are. Until then, your calls use the words below, without a Meet link."}
            </p>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void allow()}>
              {mine?.addsEvents ? "Connect again" : "Let LUME add calls to your Google Calendar"}
            </Button>
            {why && (
              <p role="alert" className={s.meetWhy}>
                {why}
              </p>
            )}
          </div>
        ))}
    </div>
  );
}
