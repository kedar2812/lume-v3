import s from "./onboarding.module.css";

/**
 * Google Calendar (everyone) and Google Sheets (admins). A card exists only when this build has that
 * integration, so nothing here ever offers a button that goes nowhere. Logos are Google's own files,
 * unmodified (public/brand/README.md); the Connect button follows Google's sign-in button guidance.
 */
export function ConnectCards({ calendar, sheets }: { calendar: boolean; sheets: boolean }) {
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
          <a className={s.gbtn} href="/settings/integrations/sheets">
            Set up
          </a>
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
          </div>
          <a className={s.gbtn} href="/settings/integrations/calendar">
            <img src="/brand/google-g.png" alt="" width={18} height={18} />
            Connect
          </a>
        </div>
      )}
    </div>
  );
}
