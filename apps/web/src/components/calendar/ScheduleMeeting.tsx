"use client";
import { SCHEDULE_MINUTES } from "@lume/core/shared";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import { calendarClient } from "@/lib/calendar/client";
import { defaultStart, startOf } from "@/lib/calendar/schedule";
import type { Meeting, Scheduled, ScheduleReady } from "@/lib/calendar/types";
import { leadsClient } from "@/lib/leads/client";
import { EMPTY_FILTERS } from "@/lib/leads/filters";
import { markAway } from "@/lib/messages/pending";
import { whatsappClient } from "@/lib/whatsapp/client";
import { startCalendarConnect } from "./ConnectCalendar";
import s from "./schedule.module.css";

type Lead = { id: string; name: string };
const first = (name: string) => name.trim().split(/\s+/)[0] || "your lead";

const CalendarPlus = () => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
    <path d="M8 3v4M16 3v4M3.5 10h17M12 13v5M9.5 15.5h5" />
  </svg>
);
const MeetMark = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="3" y="6.5" width="12.5" height="11" rx="2.5" />
    <path d="m15.5 10.5 5.5-3.5v10l-5.5-3.5" />
  </svg>
);

/**
 * Schedule a meeting (owner, 2026-11-13): the blue button on a lead's card and on the Calendar. It works once this
 * person's Google Calendar is connected and lets LUME add events; until then the sheet says what's missing and connects.
 */
export function ScheduleMeeting({
  lead = null,
  tz,
  onScheduled,
}: {
  /** The lead, on its card; none on the Calendar, where it's chosen in the sheet. */
  lead?: Lead | null;
  tz: string;
  onScheduled?: (m: Meeting) => void;
}) {
  const [open, setOpen] = useState(false);
  // Google Calendar is an optional integration: with it off for the business there's nothing to schedule with, so no
  // button. A person who only needs to connect their own calendar keeps it; its sheet connects them.
  const [off, setOff] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void calendarClient
      .scheduleReady()
      .then((r) => live && setOff(r.ok && !r.data.ready && r.data.why === "off"));
    return () => {
      live = false;
    };
  }, []);
  if (off !== false) return null;
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} className={s.trigger}>
        <CalendarPlus />
        Schedule a meeting
      </Button>
      {open && (
        <ScheduleSheet
          lead={lead}
          tz={tz}
          onClose={() => setOpen(false)}
          {...(onScheduled ? { onScheduled } : {})}
        />
      )}
    </>
  );
}

export function ScheduleSheet({
  lead,
  tz,
  onClose,
  onScheduled,
  now = () => new Date(),
}: {
  lead: Lead | null;
  tz: string;
  onClose: () => void;
  onScheduled?: (m: Meeting) => void;
  now?: () => Date;
}) {
  const [ready, setReady] = useState<ScheduleReady | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<Scheduled | null>(null);
  const [doneLead, setDoneLead] = useState<Lead | null>(lead);

  useEffect(() => {
    void calendarClient.scheduleReady().then((r) => (r.ok ? setReady(r.data) : setProblem(r.message)));
  }, []);

  return (
    <Dialog label="Schedule a meeting" onClose={onClose} width={520} className={s.panel}>
      {done && doneLead ? (
        <ScheduledView done={done} lead={doneLead} onClose={onClose} />
      ) : !ready ? (
        problem ? (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        ) : (
          <div className={s.checking} aria-busy="true" aria-label="Checking your Google Calendar" />
        )
      ) : !ready.ready ? (
        <NotReady ready={ready} onClose={onClose} />
      ) : (
        <ScheduleForm
          lead={lead}
          tz={tz}
          now={now}
          onClose={onClose}
          onDone={(r, l) => {
            setDoneLead(l);
            setDone(r);
            onScheduled?.(r.meeting);
          }}
        />
      )}
    </Dialog>
  );
}

const CONNECT: Record<
  Exclude<ScheduleReady, { ready: true }>["why"],
  { title: string; action: string | null }
> = {
  connect: { title: "Connect your Google Calendar", action: "Connect Google Calendar" },
  permission: { title: "One more permission", action: "Allow LUME to add meetings" },
  reconnect: { title: "Connect Google Calendar again", action: "Connect again" },
  off: { title: "Google Calendar is off", action: null },
};

function NotReady({
  ready,
  onClose,
}: {
  ready: Exclude<ScheduleReady, { ready: true }>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const words = CONNECT[ready.why];
  const connect = async () => {
    setBusy(true);
    setProblem(await startCalendarConnect({ addEvents: true }));
    setBusy(false);
  };
  return (
    <div className={s.notReady}>
      <span className={s.gtile} aria-hidden>
        <img src="/brand/google-calendar.png" alt="" width={26} height={26} />
      </span>
      <h2 className={s.title}>{words.title}</h2>
      <p className={s.lede}>{ready.message}</p>
      <p className={s.fine}>
        LUME only adds meetings to its own LUME calls calendar, each with a Google Meet link.
      </p>
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      <div className={s.foot}>
        <Button variant="ghost" onClick={onClose}>
          {words.action ? "Not now" : "Close"}
        </Button>
        {words.action && (
          <Button variant="primary" loading={busy} onClick={() => void connect()}>
            {words.action}
          </Button>
        )}
      </div>
    </div>
  );
}

function LeadSearch({ onPick }: { onPick: (l: Lead) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Lead[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const asked = useRef(0);
  useEffect(() => {
    const words = q.trim();
    const n = ++asked.current; // any answer to an earlier search is now stale
    if (words.length < 2) return setFound(null);
    const t = setTimeout(async () => {
      const r = await leadsClient.list({ ...EMPTY_FILTERS, q: words }, undefined, 6);
      if (n !== asked.current) return; // a later search is on its way
      if (!r.ok) return setProblem(r.message);
      setProblem(null);
      setFound(r.data.items.map((l) => ({ id: l.id, name: l.name ?? "" })));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className={s.search}>
      <input
        type="search"
        className={s.input}
        aria-label="Find a lead"
        placeholder="Find a lead by name, phone or email"
        value={q}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
      />
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      {found && (
        <ul className={s.found} aria-label="Leads found">
          {found.length === 0 ? (
            <li className={s.none}>No lead matches “{q.trim()}”.</li>
          ) : (
            found.map((l) => (
              <li key={l.id}>
                <button type="button" onClick={() => onPick(l)}>
                  {l.name || "Unnamed lead"}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function ScheduleForm({
  lead: fixed,
  tz,
  now,
  onClose,
  onDone,
}: {
  lead: Lead | null;
  tz: string;
  now: () => Date;
  onClose: () => void;
  onDone: (r: Scheduled, lead: Lead) => void;
}) {
  const id = useId();
  const [lead, setLead] = useState<Lead | null>(fixed);
  const [title, setTitle] = useState(fixed ? `Call with ${first(fixed.name)}` : "");
  const [titleTouched, setTitleTouched] = useState(false);
  const start = useRef(defaultStart(now(), tz)).current;
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [minutes, setMinutes] = useState<string>("30");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const pick = (l: Lead) => {
    setLead(l);
    if (!titleTouched) setTitle(`Call with ${first(l.name)}`);
  };
  const at = startOf(date, time, tz);
  const missing = !lead
    ? "Choose who the meeting is with."
    : !title.trim()
      ? "Give the meeting a title."
      : !at
        ? "Choose a day and a time."
        : null;

  const submit = async () => {
    if (missing || !lead || !at || busy) return;
    setBusy(true);
    setProblem(null);
    const r = await calendarClient.schedule({
      leadId: lead.id,
      title: title.trim(),
      startsAt: at,
      minutes: Number(minutes),
      notes: notes.trim(),
    });
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    onDone(r.data, lead);
  };

  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className={s.title}>Schedule a meeting</h2>
      <input
        className={s.titleInput}
        aria-label="Title"
        autoFocus={!!fixed}
        placeholder="Add a title"
        maxLength={200}
        value={title}
        onChange={(e) => {
          setTitleTouched(true);
          setTitle(e.target.value);
        }}
      />
      <div className={s.row}>
        <span className={s.rowLabel} id={`${id}-with`}>
          With
        </span>
        {lead ? (
          <span className={s.leadChip} aria-labelledby={`${id}-with`}>
            <b>{lead.name || "Unnamed lead"}</b>
            {!fixed && (
              <button type="button" className={s.change} onClick={() => setLead(null)}>
                Change
              </button>
            )}
          </span>
        ) : (
          <LeadSearch onPick={pick} />
        )}
      </div>
      <div className={s.row}>
        <span className={s.rowLabel}>When</span>
        <div className={s.when}>
          <input
            type="date"
            className={s.input}
            aria-label="Day"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
          <input
            type="time"
            className={s.input}
            aria-label="Time"
            step={300}
            value={time}
            onChange={(e) => setTime(e.target.value)}
            required
          />
        </div>
      </div>
      <div className={s.row}>
        <span className={s.rowLabel}>Length</span>
        <SegmentedControl
          size="sm"
          label="Length"
          value={minutes}
          options={SCHEDULE_MINUTES.map((m) => ({ value: String(m), label: `${m} min` }))}
          onChange={setMinutes}
        />
      </div>
      <div className={s.meetLine}>
        <MeetMark />
        <span>A Google Meet link is made for it, on your LUME calls calendar.</span>
      </div>
      <textarea
        className={s.notes}
        aria-label="Notes"
        placeholder="Add notes for the invite"
        maxLength={1000}
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      <div className={s.foot}>
        <span className={s.need}>{lead && !busy ? (missing ?? "") : ""}</span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!!missing}>
          Schedule
        </Button>
      </div>
    </form>
  );
}

function ScheduledView({ done, lead, onClose }: { done: Scheduled; lead: Lead; onClose: () => void }) {
  const [text, setText] = useState(done.message);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<"sent" | "opened" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID()).current;
  const wa = done.whatsapp;
  const name = first(lead.name);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(done.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setProblem("Your browser didn't let LUME copy. Select the link and copy it.");
    }
  };
  const send = async () => {
    if (!text.trim()) return setProblem("Write a message first.");
    setSending(true);
    setProblem(null);
    const r = await whatsappClient.send(lead.id, { clientKey: key, text: text.trim() });
    setSending(false);
    if (!r.ok) return setProblem(r.message);
    setSent("sent");
  };
  const openWhatsApp = async () => {
    if (!text.trim()) return setProblem("Write a message first.");
    setProblem(null);
    const tab = window.open("", "_blank");
    if (!tab) return setProblem("Your browser blocked the new tab. Allow pop-ups for LUME, then try again.");
    tab.opener = null;
    setSending(true);
    const r = await leadsClient.prepareMessage(lead.id, text.trim());
    setSending(false);
    if (!r.ok) {
      tab.close();
      return setProblem(r.message);
    }
    tab.location.href = r.data.url;
    // Back in LUME, the shell asks whether it went, naming the lead.
    markAway({ leadId: lead.id, leadName: lead.name, by: Symbol("schedule-meeting") });
    setSent("opened");
  };

  return (
    <div className={s.done}>
      <span className={s.tick} aria-hidden>
        <svg viewBox="0 0 16 16" width="18" height="18">
          <path
            d="M3.5 8.5l3 3 6-7"
            fill="none"
            stroke="#fff"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <h2 className={s.title}>Meeting scheduled</h2>
      <p className={s.lede}>
        {done.meeting.title} · {done.label}
      </p>
      <div className={s.linkRow}>
        <MeetMark />
        <a href={done.link} target="_blank" rel="noreferrer" className={s.link}>
          {done.link.replace(/^https:\/\//, "")}
        </a>
        <Button size="sm" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>

      <section className={s.wa} aria-label="Send the link on WhatsApp">
        <h3 className={s.waTitle}>
          <WhatsAppIcon size={16} />
          Send {name} the link on WhatsApp?
        </h3>
        {sent === "sent" ? (
          <p className={s.sent} role="status">
            Sent on WhatsApp. It’s in {name}’s chat in LUME.
          </p>
        ) : sent === "opened" ? (
          <p className={s.sent} role="status">
            WhatsApp opened with the message ready. Press send there.
          </p>
        ) : wa.open || wa.send ? (
          <>
            {!wa.send && wa.why && (
              <p className={s.why}>
                {wa.why} You can send it from your own WhatsApp instead, with the message filled in.
              </p>
            )}
            <textarea
              className={s.notes}
              aria-label="Message"
              rows={3}
              maxLength={4096}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </>
        ) : (
          <p className={s.why}>{wa.why}</p>
        )}
        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}
      </section>

      <div className={s.foot}>
        {sent || (!wa.send && !wa.open) ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
            {wa.send ? (
              <Button variant="whatsapp" loading={sending} onClick={() => void send()}>
                Send on WhatsApp
              </Button>
            ) : (
              <Button variant="whatsapp" loading={sending} onClick={() => void openWhatsApp()}>
                Open WhatsApp with this message
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
