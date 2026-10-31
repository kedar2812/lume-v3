"use client";

import { useState } from "react";
import { startCalendarConnect } from "@/components/calendar/ConnectCalendar";
import s from "./onboarding.module.css";

/**
 * Google Calendar (everyone) and Google Sheets (admins). A card exists only when this build has that
 * integration, so nothing here ever offers a button that goes nowhere. Logos are Google's own files,
 * unmodified (public/brand/README.md); the Connect button follows Google's sign-in button guidance.
 * Calendar's Connect goes to Google from here and comes back to onboarding (the Calendar page itself waits
 * until onboarding is done); a refusal is said on the card. Sheets is set up on Integrations (choosing the sheet
 * and its columns), which waits until onboarding is done too, so the card says where, with no button.
 */
export function ConnectCards({ calendar, sheets }: { calendar: boolean; sheets: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    setError(await startCalendarConnect());
    setBusy(false);
  };
  return (
    <div className={s.conns}>
      {sheets && (
        <div className={s.conn}>
          <span className={s.connIcon}>
            <img src="/brand/google-sheets.png" alt="Google Sheets" width={28} height={28} />
          </span>
          <div className={s.connText}>
            <b>
              Google Sheets <span className={s.badge}>Admins</span>
            </b>
            <span>Bring leads in from the sheet your forms write to. New rows arrive every two minutes.</span>
          </div>
          <span className={s.connLater}>After setup, in Settings → Integrations</span>
        </div>
      )}
      {calendar && (
        <div className={s.conn}>
          <span className={s.connIcon}>
            <img src="/brand/google-calendar.png" alt="Google Calendar" width={28} height={28} />
          </span>
          <div className={s.connText}>
            <b>Google Calendar</b>
            <span>See your lead calls in LUME. LUME only reads events that involve your leads.</span>
            {error && (
              <span role="alert" className={s.connError}>
                {error}
              </span>
            )}
          </div>
          <button
            type="button"
            className={s.gbtn}
            onClick={connect}
            disabled={busy}
            aria-busy={busy}
            aria-label="Connect Google Calendar"
          >
            <img src="/brand/google-g.png" alt="" width={18} height={18} />
            Connect
          </button>
        </div>
      )}
    </div>
  );
}
