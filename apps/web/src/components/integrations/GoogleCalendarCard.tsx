"use client";
import { useState } from "react";
import { Switch } from "@/components/ui/Switch";
import { calendarClient } from "@/lib/calendar/client";
import type { IntegrationsView } from "@/lib/sheets/types";
import s from "./integrations.module.css";

/**
 * Google Calendar as an optional module (5A): one switch. On, each person connects their own calendar from
 * the Calendar page or Settings → Calendar; off, nobody's is read. Not set up on this server, it says so.
 */
export function GoogleCalendarCard({
  googleCalendar,
  onView,
}: {
  googleCalendar: IntegrationsView["googleCalendar"];
  onView(v: IntegrationsView): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const toggle = async (enabled: boolean) => {
    setError(null);
    const r = await calendarClient.setEnabled(enabled);
    if (!r.ok) return setError(r.message);
    onView(r.data);
  };
  return (
    <article className={s.card} aria-labelledby="gc-title">
      <header className={s.cardHead}>
        <span className={s.brandTile}>
          <img src="/brand/google-calendar.png" alt="" width={28} height={28} />
        </span>
        <div className={s.cardText}>
          <h2 id="gc-title" className={s.cardTitle}>
            Google Calendar
          </h2>
          <p className={s.cardLede}>
            {googleCalendar.enabled
              ? "On · people connect their own calendar, and only meetings with leads come in."
              : "Meetings with leads show on their leads and in the Calendar. Read-only; personal events are never kept."}
          </p>
        </div>
        {googleCalendar.available && (
          <Switch
            checked={googleCalendar.enabled}
            onChange={(v) => void toggle(v)}
            label="Google Calendar"
            labelHidden
          />
        )}
      </header>
      {!googleCalendar.available && (
        <p className={s.note}>
          Google Calendar comes through Connect with Google, which isn&apos;t set up on this server yet. The
          person who installed LUME can switch it on.
        </p>
      )}
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
    </article>
  );
}
