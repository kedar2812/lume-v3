"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CalendarRefresh } from "@/components/calendar/CalendarRefresh";
import { ConnectCalendar } from "@/components/calendar/ConnectCalendar";
import { backToCalendar } from "@/components/calendar/CalendarGear";
import { Switch } from "@/components/ui/Switch";
import { calendarClient } from "@/lib/calendar/client";
import type { CalendarConnection } from "@/lib/calendar/types";
import s from "./calendar-settings.module.css";

/** "2 min ago", "just now", "3 h ago". */
function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "not yet";
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/**
 * Settings → Calendar (canvas Connect, the settings view): who's connected, when LUME last read it, Refresh;
 * which calendars LUME reads (green switches, rolled back if Google refuses); Disconnect, asked first, in red;
 * the Calendly row for an admin. Not connected (or disconnected here), the connect card.
 */
export function CalendarSettings({
  initial,
  calendly,
}: {
  initial: CalendarConnection;
  /** Shown to an admin (integrations.manage); null for everyone else. */
  calendly: { connected: boolean } | null;
}) {
  const [conn, setConn] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [back, setBack] = useState("/calendar");
  // The gear remembered the exact Calendar view (read after mount: the server can't know it).
  useEffect(() => setBack(backToCalendar()), []);

  const backLink = (
    <Link href={back} className={s.back}>
      ‹ Calendar
    </Link>
  );

  if (!conn.connected)
    return (
      <div className={s.wrap}>
        {backLink}
        <ConnectCalendar state={conn.available ? "connect" : "off"} admin={!!calendly} />
        {calendly && <CalendlyRow connected={calendly.connected} />}
      </div>
    );

  const choose = async (id: string, on: boolean) => {
    if (!conn.connected) return;
    setError(null);
    const was = conn;
    const calendars = conn.calendars.map((c) => (c.id === id ? { ...c, chosen: on } : c));
    setConn({ ...conn, calendars });
    const r = await calendarClient.chooseCalendars(calendars.filter((c) => c.chosen).map((c) => c.id));
    if (!r.ok) {
      setConn(was);
      return setError(r.message);
    }
    if (r.data.connected) setConn(r.data);
  };

  const disconnect = async () => {
    setLeaving(true);
    const r = await calendarClient.disconnect();
    setLeaving(false);
    setAsking(false);
    if (!r.ok) return setError(r.message);
    setConn(r.data);
  };

  const reload = async () => {
    const r = await calendarClient.connection();
    if (r.ok) setConn(r.data);
  };

  return (
    <div className={s.wrap}>
      {backLink}
      {conn.status === "needs_reconnect" && (
        <div className={s.amber} role="status" aria-label="Needs reconnecting">
          <span>{conn.lastError ?? "Google stopped letting LUME read your calendar."}</span>
          <button
            type="button"
            className={s.amberBtn}
            onClick={async () => {
              const r = await calendarClient.connect();
              if (r.ok) window.location.assign(r.data.url);
              else setError(r.message);
            }}
          >
            Connect again
          </button>
        </div>
      )}

      <section className={s.card} aria-label="Connected calendar">
        <div className={s.who}>
          <span className={s.gtile}>
            <img src="/brand/google-calendar.png" alt="Google Calendar" width={26} height={26} />
          </span>
          <span className={s.whoText}>
            <small>Connected as</small>
            <b>{conn.googleEmail}</b>
            <small>Last synced {ago(conn.lastSyncedAt)} · every 5 minutes</small>
          </span>
          {conn.status === "active" && <CalendarRefresh shortcut={false} onSynced={() => void reload()} />}
        </div>
      </section>

      <section className={s.card} aria-labelledby="cal-read">
        <h2 id="cal-read" className={s.h2}>
          Calendars LUME reads
        </h2>
        <p className={s.lede}>
          These are the calendars you own; LUME can't read calendars others share with you. Only meetings with
          your leads are kept from them. Other events are read to find them, never kept.
        </p>
        {error && (
          <p role="alert" className={s.err}>
            {error}
          </p>
        )}
        <ul className={s.list}>
          {conn.calendars.map((c) => (
            <li key={c.id}>
              <Switch label={c.name} checked={c.chosen} onChange={(on) => void choose(c.id, on)} />
            </li>
          ))}
        </ul>
      </section>

      {calendly && <CalendlyRow connected={calendly.connected} />}

      <section className={s.leave}>
        {asking ? (
          <div role="group" aria-label="Disconnect Google Calendar" className={s.confirm}>
            <p>
              LUME forgets this connection and every meeting it brought into LUME. Your Google Calendar itself
              doesn&apos;t change.
            </p>
            <div className={s.confirmBtns}>
              <button type="button" className={s.quiet} onClick={() => setAsking(false)}>
                Keep it
              </button>
              <button type="button" className={s.danger} disabled={leaving} onClick={() => void disconnect()}>
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={s.dangerQuiet} onClick={() => setAsking(true)}>
            Disconnect
          </button>
        )}
      </section>
    </div>
  );
}

function CalendlyRow({ connected }: { connected: boolean }) {
  return (
    <Link href="/settings/integrations/calendly" className={s.calendly}>
      <img src="/brand/calendly.svg" alt="" width={28} height={28} />
      <span>
        <b>Calendly</b>
        <small>
          Bookings arrive in seconds and move leads to their booking stage · set up in Integrations
        </small>
      </span>
      <span className={s.pill} data-on={connected || undefined}>
        {connected ? "On" : "Off"}
      </span>
      <span aria-hidden className={s.chev}>
        ›
      </span>
    </Link>
  );
}
