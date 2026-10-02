"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/Switch";
import { calendarClient } from "@/lib/calendar/client";
import type { CalendlySettings, CalendlyView } from "@/lib/calendar/types";
import s from "./calendly.module.css";

const STEP_MS = 650;

/**
 * Calendly in Settings → Integrations (canvas Calendly). Not connected: the story (someone books → their lead
 * is found or made → moved to the booking stage), the token and where to make one, "kept sealed". Connecting:
 * three checks tick in order. Connected: Receiving, two green switches, the phone question, where booked
 * leads move to, and Disconnect (asked first). Refusals are the server's words; the token is never shown.
 */
export function CalendlyCard({ initial }: { initial: CalendlyView }) {
  const [view, setView] = useState(initial);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [ticked, setTicked] = useState(0);
  const [pending, setPending] = useState<Extract<CalendlyView, { connected: true }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState(initial.connected ? (initial.settings.phoneQuestion ?? "") : "");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const connect = async () => {
    setError(null);
    setBusy(true);
    const r = await calendarClient.connectCalendly(token.trim());
    setBusy(false);
    // The token leaves the page either way: it's sealed on the server now, or it was refused.
    setToken("");
    if (!r.ok) return setError(r.message);
    if (!r.data.connected) return setView(r.data);
    setPending(r.data);
    setTicked(1);
    timers.current = [
      setTimeout(() => setTicked(2), STEP_MS),
      setTimeout(() => setTicked(3), STEP_MS * 2),
      setTimeout(
        () => {
          setView(r.data);
          setPending(null);
          setTicked(0);
          setQuestion(r.data.connected ? (r.data.settings.phoneQuestion ?? "") : "");
        },
        STEP_MS * 3 + 400,
      ),
    ];
  };

  const patch = async (p: Partial<CalendlySettings>) => {
    if (!view.connected) return;
    setError(null);
    const was = view;
    setView({ ...view, settings: { ...view.settings, ...p } });
    const r = await calendarClient.patchCalendly(p);
    if (!r.ok) {
      setView(was);
      return setError(r.message);
    }
    setView(r.data);
  };

  const disconnect = async () => {
    const r = await calendarClient.disconnectCalendly();
    setAsking(false);
    if (!r.ok) return setError(r.message);
    setView(r.data);
  };

  const head = (
    <header className={s.head}>
      <img className={s.mark} src="/brand/calendly.svg" alt="Calendly" width={52} height={52} />
      <div>
        <h2 id="calendly-title" className={s.title}>
          Calendly
          {view.connected && view.status === "active" && (
            <span className={s.live}>
              <i aria-hidden />
              Receiving
            </span>
          )}
        </h2>
        <p className={s.lede}>
          A booking makes or finds its lead, moves it to the booking stage, and tells its owner. In seconds.
        </p>
      </div>
    </header>
  );

  if (pending)
    return (
      <article className={s.card} aria-labelledby="calendly-title">
        {head}
        <ol className={s.checks} aria-label="Connecting Calendly">
          <li data-done={ticked >= 1 || undefined}>Token accepted · {pending.account.name}</li>
          <li data-done={ticked >= 2 || undefined}>
            {pending.scope === "organization" ? "Organisation found" : "Your Calendly account found"}
          </li>
          <li data-done={ticked >= 3 || undefined}>Bookings now come to LUME</li>
        </ol>
      </article>
    );

  if (!view.connected)
    return (
      <article className={s.card} aria-labelledby="calendly-title">
        {head}
        <ol className={s.story}>
          <li>
            <img src="/brand/calendly.svg" alt="" width={22} height={22} />
            <span>
              <b>Someone books</b>
              <small>a call on your Calendly</small>
            </span>
          </li>
          <li>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21a8 8 0 0 1 16 0" />
            </svg>
            <span>
              <b>Lead found or made</b>
              <small>by email, then phone</small>
            </span>
          </li>
          <li data-end>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M9 4v16M15 4v16" />
            </svg>
            <span>
              <b>Moved to its booking stage</b>
              <small>and its owner told</small>
            </span>
          </li>
        </ol>
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim().length >= 10 && !busy) void connect();
          }}
        >
          <label htmlFor="calendly-token" className={s.label}>
            Calendly personal access token
          </label>
          <div className={s.row}>
            <input
              id="calendly-token"
              className={s.input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button type="submit" className={s.primary} disabled={token.trim().length < 10 || busy}>
              Connect Calendly
            </button>
          </div>
          <p className={s.where}>
            <span>
              Make one in Calendly: <kbd>Integrations</kbd> › <kbd>API &amp; webhooks</kbd> ›{" "}
              <kbd>Personal access tokens</kbd>
            </span>
            <span className={s.sealed}>Kept sealed; never shown again</span>
          </p>
          {error && (
            <p role="alert" className={s.err}>
              {error}
            </p>
          )}
        </form>
      </article>
    );

  return (
    <article className={s.card} aria-labelledby="calendly-title">
      {head}
      {view.status === "needs_attention" && (
        <p role="status" aria-label="Needs attention" className={s.attention}>
          {view.lastError ?? "Calendly needs attention."}
        </p>
      )}
      <p className={s.meta}>
        Connected as <b>{view.account.name}</b> ({view.account.email})
        {view.runAs ? ` · leads and moves are made in ${view.runAs.name}'s name` : ""}
      </p>
      <ul className={s.settings}>
        <li>
          <Switch
            label="Make a lead for someone new"
            checked={view.settings.createLeads}
            onChange={(v) => void patch({ createLeads: v })}
          />
        </li>
        <li>
          <Switch
            label="Set a Reschedule follow-up when a booking is cancelled"
            checked={view.settings.rescheduleFollowUp}
            onChange={(v) => void patch({ rescheduleFollowUp: v })}
          />
        </li>
        <li className={s.question}>
          <label htmlFor="calendly-q">The booking question that asks for a phone number</label>
          <input
            id="calendly-q"
            className={s.input}
            placeholder="Calendly's own phone number field"
            value={question}
            maxLength={200}
            onChange={(e) => setQuestion(e.target.value)}
            onBlur={() => {
              const q = question.trim() || null;
              if (q !== view.settings.phoneQuestion) void patch({ phoneQuestion: q });
            }}
          />
        </li>
        <li>
          <Link href="/settings/pipeline" className={s.link}>
            Booked leads move to the stage you choose in Pipeline &amp; stages ›
          </Link>
        </li>
      </ul>
      {error && (
        <p role="alert" className={s.err}>
          {error}
        </p>
      )}
      {asking ? (
        <div role="group" aria-label="Disconnect Calendly" className={s.confirm}>
          <p>New bookings stop coming to LUME. Leads and meetings already here stay.</p>
          <div>
            <button type="button" className={s.quiet} onClick={() => setAsking(false)}>
              Keep it
            </button>
            <button type="button" className={s.danger} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={s.dangerQuiet} onClick={() => setAsking(true)}>
          Disconnect
        </button>
      )}
    </article>
  );
}
