"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { calendarClient } from "@/lib/calendar/client";
import type { CalendlyOptions, CalendlyScheduled, Meeting } from "@/lib/calendar/types";
import { dayKey, timeOf } from "@/lib/dates";
import { roving } from "@/lib/roving";
import { LeadSearch, SendLink, type Lead } from "./ScheduleMeeting";
import s from "./schedule.module.css";

const first = (name: string) => name.trim().split(/\s+/)[0] || "the lead";
const dayWords = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(
    new Date(iso),
  );

/**
 * Schedule a meeting on Calendly (owner 2026-11-27: "allow lume to schedule calls in calendly"): the lead, then one of
 * the free times of LUME's booking link, as Calendly itself offers them. Calendly books it and sends the lead its own
 * invite and reminders; the meeting is on the lead at once.
 */
export function CalendlyBook({
  lead: fixed,
  tz,
  onClose,
  onBooked,
}: {
  lead: Lead | null;
  tz: string;
  onClose: () => void;
  onBooked?: (m: Meeting) => void;
}) {
  const id = useId();
  const [lead, setLead] = useState<Lead | null>(fixed);
  const [opts, setOpts] = useState<CalendlyOptions | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [day, setDay] = useState("");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<CalendlyScheduled | null>(null);

  // The free times are read once there's a lead: Calendly is asked about that lead, never before.
  const load = (who: Lead | null) => {
    setOpts(null);
    setFailed(null);
    setAt("");
    if (!who) return;
    void calendarClient.calendlyOptions(who.id).then((r) => {
      if (!r.ok) return setFailed(r.message);
      setOpts(r.data);
      setDay(r.data.times[0] ? dayKey(new Date(r.data.times[0]), tz) : "");
    });
  };
  useEffect(() => load(lead), [lead]);

  // The free times, by day on this person's clock.
  const days = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const t of opts?.times ?? []) {
      const k = dayKey(new Date(t), tz);
      by.set(k, [...(by.get(k) ?? []), t]);
    }
    return by;
  }, [opts, tz]);

  const book = async () => {
    if (!lead || !at || busy) return;
    setBusy(true);
    setProblem(null);
    const r = await calendarClient.scheduleCalendly({ leadId: lead.id, startsAt: at });
    setBusy(false);
    if (!r.ok) {
      setProblem(r.message);
      // A time taken meanwhile: the free times are read again.
      if (r.code === "CALENDLY_TIME_TAKEN") load(lead);
      return;
    }
    setDone(r.data);
    onBooked?.(r.data.meeting);
  };

  if (done && lead)
    return (
      <div className={s.form}>
        <h2 className={s.title}>Booked in Calendly</h2>
        <p className={s.lede}>
          {done.meeting.title} with {lead.name || "the lead"}, {done.label}.
        </p>
        <p className={s.fine}>Calendly has sent {first(lead.name)} its own invite and reminders.</p>
        <div className={s.foot}>
          <span className={s.need} />
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );

  const ready = opts?.ready;
  const times = days.get(day) ?? [];
  // Calendly can't book them (no email): the booking link goes to them instead, to pick a time themselves.
  if (lead && opts?.send && ready && !ready.ready)
    return (
      <div className={s.form}>
        <h2 className={s.title}>Book on Calendly</h2>
        <p className={s.lede}>{ready.message}</p>
        <SendLink
          lead={lead}
          message={opts.send.message}
          wa={opts.send.whatsapp}
          onClose={onClose}
          what="the booking link"
        />
      </div>
    );
  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        void book();
      }}
    >
      <h2 className={s.title}>Book on Calendly</h2>
      <div className={s.row}>
        <span className={s.rowLabel} id={`${id}-with`}>
          With
        </span>
        {lead ? (
          <span className={s.leadChip} role="group" aria-labelledby={`${id}-with`}>
            <b>{lead.name || "Unnamed lead"}</b>
            {!fixed && (
              <button type="button" className={s.change} onClick={() => setLead(null)}>
                Change
              </button>
            )}
          </span>
        ) : (
          <LeadSearch onPick={setLead} />
        )}
      </div>
      {!lead ? null : failed ? (
        <p role="alert" className={s.problem}>
          {failed}
        </p>
      ) : !opts ? (
        <div
          className={s.checking}
          role="status"
          aria-busy="true"
          aria-label="Reading Calendly's free times"
        />
      ) : !ready!.ready ? (
        <p role="alert" className={s.problem}>
          {ready!.message}
        </p>
      ) : (
        <>
          {ready!.link && (
            <p className={s.fine}>
              On <b>{ready!.link.name}</b> ({ready!.link.duration} min), at the times it&apos;s free in
              Calendly.
            </p>
          )}
          {days.size === 0 ? (
            <p className={s.lede}>No free times in the next two weeks on this link.</p>
          ) : (
            <>
              <div className={s.row}>
                <label className={s.rowLabel} htmlFor={`${id}-day`}>
                  Day
                </label>
                <select
                  id={`${id}-day`}
                  className={s.input}
                  value={day}
                  onChange={(e) => {
                    setDay(e.target.value);
                    setAt("");
                  }}
                >
                  {[...days.keys()].map((k) => (
                    <option key={k} value={k}>
                      {dayWords(days.get(k)![0]!, tz)}
                    </option>
                  ))}
                </select>
              </div>
              <div
                className={s.slots}
                role="radiogroup"
                aria-label="Free times"
                onKeyDown={(e) => roving(e, "radio")}
              >
                {times.map((t, i) => (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={at === t}
                    tabIndex={at === t || (!times.includes(at) && i === 0) ? 0 : -1}
                    className={s.slot}
                    onClick={() => setAt(t)}
                  >
                    {timeOf(new Date(t), tz)}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      <div className={s.foot}>
        <span className={s.need}>{lead && ready?.ready && !at ? "Choose a time." : ""}</span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!lead || !at || !ready?.ready}>
          Book on Calendly
        </Button>
      </div>
    </form>
  );
}
