"use client";
import { GoogleDataNote } from "./GoogleDataNote";
import { useCallback, useEffect, useState } from "react";
import { AddSheetSheet } from "@/components/sheets/AddSheetSheet";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { calendarClient } from "@/lib/calendar/client";
import type { CalendlyView } from "@/lib/calendar/types";
import { sheetsClient } from "@/lib/sheets/client";
import type { IntegrationsView, SheetSourceView } from "@/lib/sheets/types";
import { AttentionBanner } from "./AttentionBanner";
import { CalendlyCard } from "./CalendlyCard";
import { GoogleCalendarCard } from "./GoogleCalendarCard";
import { SheetSourceList } from "./SheetSourceList";
import { WebhooksCard } from "./WebhooksCard";
import s from "./integrations.module.css";

/** Spec §7.1: each optional module is one card — what it does, a switch, and what it needs from you. */
export function Integrations() {
  const [view, setView] = useState<IntegrationsView | null>(null);
  const [sources, setSources] = useState<SheetSourceView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calendly, setCalendly] = useState<CalendlyView | null>(null);

  const loadSources = useCallback(async () => {
    const r = await sheetsClient.list();
    if (r.ok) setSources(r.data.sources);
  }, []);
  useEffect(() => {
    void sheetsClient.integrations().then((r) => {
      if (!r.ok) return setError(r.message);
      setView(r.data);
      if (r.data.googleSheets.enabled) void loadSources();
    });
    void calendarClient.calendly().then((r) => r.ok && setCalendly(r.data));
  }, [loadSources]);

  // While any sheet is checking, look again every 2 seconds, so "Checking now" turns into what it found.
  const checking = !!sources?.some((x) => x.syncing);
  useEffect(() => {
    if (!checking) return;
    const t = setTimeout(() => void loadSources(), 2000);
    return () => clearTimeout(t);
  }, [checking, sources, loadSources]);

  const share = (email: string) => (
    <div className={s.share}>
      <span className={s.shareLabel}>Share each sheet with LUME as a Viewer:</span>
      <code className={s.email}>{email}</code>
      <Button size="sm" aria-label={copied ? "Copied" : "Copy email"} onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );

  if (error)
    return (
      <p role="alert" className={s.error}>
        {error}
      </p>
    );
  if (!view) return null;
  const g = view.googleSheets;

  const toggle = async (enabled: boolean) => {
    setError(null);
    const r = await sheetsClient.setEnabled(enabled);
    if (!r.ok) return setError(r.message);
    setView(r.data);
    if (enabled) void loadSources();
  };
  const startConnect = async () => {
    setError(null);
    const r = await sheetsClient.connect();
    if (!r.ok) return setError(r.message);
    window.location.assign(r.data.url);
  };
  const copy = async () => {
    if (!g.email) return;
    await navigator.clipboard.writeText(g.email);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <>
      <AttentionBanner items={(sources ?? []).filter((x) => x.status === "needs_attention")} />
      <article className={s.card} aria-labelledby="gs-title">
        <header className={s.cardHead}>
          <span className={s.brandTile}>
            <img src="/brand/google-sheets.png" alt="" width={28} height={28} />
          </span>
          <div className={s.cardText}>
            <h2 id="gs-title" className={s.cardTitle}>
              Google Sheets
            </h2>
            <p className={s.cardLede}>
              New rows in your sheets become leads — every few minutes, or at once with Refresh.
            </p>
          </div>
          {g.available && (
            <Switch checked={g.enabled} onChange={(v) => void toggle(v)} label="Google Sheets" labelHidden />
          )}
        </header>
        {!g.available && (
          <p className={s.note}>
            Google Sheets isn't set up on this server yet. The person who installed LUME can add its Google
            key.
          </p>
        )}
        {g.enabled && (g.email || g.connectWithGoogle) && (
          <>
            {g.connectWithGoogle && (
              <div className={s.connect}>
                <button type="button" className={s.googleButton} onClick={() => void startConnect()}>
                  <img src="/brand/google-g.png" alt="" width={18} height={18} />
                  Continue with Google
                </button>
                <p className={s.cardLede}>
                  Sign in to Google and pick the sheet. LUME can open only the sheets you pick.
                </p>
                <GoogleDataNote what="LUME can open only the files you pick in Google's file picker, and reads their rows as leads." />
              </div>
            )}
            {g.email &&
              (g.connectWithGoogle ? (
                <details className={s.other}>
                  <summary>Other ways</summary>
                  {share(g.email)}
                </details>
              ) : (
                share(g.email)
              ))}
            {sources && <SheetSourceList sources={sources} />}
            {g.email && (
              <div className={s.cardFoot}>
                <Button
                  variant={g.connectWithGoogle ? "secondary" : "primary"}
                  onClick={() => setAdding(true)}
                >
                  {g.connectWithGoogle ? "Add a sheet by its link" : "Add a sheet"}
                </Button>
              </div>
            )}
          </>
        )}
      </article>
      <WebhooksCard webhooks={view.webhooks} onView={setView} />
      {view.googleCalendar && <GoogleCalendarCard googleCalendar={view.googleCalendar} onView={setView} />}
      {calendly && <CalendlyCard initial={calendly} />}
      <AddSheetSheet
        open={adding}
        onClose={() => {
          setAdding(false);
          void loadSources();
        }}
      />
    </>
  );
}
