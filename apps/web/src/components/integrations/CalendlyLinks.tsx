"use client";
import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/Switch";
import { calendarClient } from "@/lib/calendar/client";
import type { CalendlyLinks as Links, CalendlySettings } from "@/lib/calendar/types";
import s from "./calendly.module.css";

/**
 * Which Calendly links are for leads, and LUME's booking link (owner 2026-11-27: "calendly link selection for lume";
 * "lume has to fetch data relevant to leads only"). A booking on a link that isn't for leads never comes into LUME.
 * Until someone chooses, every link counts, and it says so.
 */
export function CalendlyLinks({
  onSave,
}: {
  /** Saves part of Calendly's settings; resolves with LUME's refusal in words, or null when saved. */
  onSave: (p: Partial<CalendlySettings>) => Promise<string | null>;
}) {
  const [data, setData] = useState<Links | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setFailed(null);
    void calendarClient.calendlyLinks().then((r) => (r.ok ? setData(r.data) : setFailed(r.message)));
  };
  useEffect(load, []);

  const save = async (p: Partial<CalendlySettings>, next: Links) => {
    setError(null);
    const was = data;
    setData(next);
    const why = await onSave(p);
    if (why) {
      setData(was);
      setError(why);
    }
  };
  const toggle = (uri: string, on: boolean) => {
    if (!data) return;
    const links = data.links.map((l) => (l.uri === uri ? { ...l, forLeads: on } : l));
    // A saved link Calendly didn't list this time (turned off there, or far down the list) stays saved.
    const unseen = (data.saved ?? []).filter((u) => !links.some((l) => l.uri === u));
    const chosen = [...unseen, ...links.filter((l) => l.forLeads).map((l) => l.uri)];
    // A link no longer for leads can't stay LUME's booking link.
    const bookWith = data.bookWith && chosen.includes(data.bookWith) ? data.bookWith : null;
    void save(
      { links: chosen, ...(bookWith !== data.bookWith ? { bookWith } : {}) },
      { every: false, bookWith, links },
    );
  };

  if (failed)
    return (
      <section className={s.links} aria-label="Links for leads">
        <h3 className={s.linksTitle}>Which links are for leads</h3>
        <p role="alert" className={s.err}>
          {failed}{" "}
          <button type="button" className={s.retry} onClick={load}>
            Try again
          </button>
        </p>
      </section>
    );
  if (!data)
    return (
      <section className={s.links} aria-label="Links for leads" aria-busy>
        <h3 className={s.linksTitle}>Which links are for leads</h3>
        <p className={s.meta}>Reading the links in Calendly…</p>
      </section>
    );
  const bookable = data.links.filter((l) => l.forLeads && l.bookable);
  const notBookable = data.links.filter((l) => l.forLeads && !l.bookable);
  return (
    <section className={s.links} aria-label="Links for leads">
      <h3 className={s.linksTitle}>Which links are for leads</h3>
      <p className={s.meta}>
        Only bookings on these links come into LUME. A booking on any other (a client&apos;s session, a
        personal event) is never kept.
      </p>
      {data.every && (
        <p role="status" className={s.attention}>
          LUME takes bookings from every Calendly link. Choose the ones for leads.
        </p>
      )}
      {data.links.length === 0 ? (
        <p className={s.meta}>This Calendly account has no active links yet.</p>
      ) : (
        <ul className={s.settings}>
          {data.links.map((l) => (
            <li key={l.uri} className={s.linkRow}>
              <Switch label={l.name} checked={l.forLeads} onChange={(v) => toggle(l.uri, v)} />
              <span className={s.linkSub}>
                {l.duration} min{l.owner ? ` · ${l.owner}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className={s.question}>
        <label htmlFor="calendly-book-with">LUME&apos;s booking link</label>
        <select
          id="calendly-book-with"
          className={s.input}
          value={data.bookWith ?? ""}
          onChange={(e) => {
            const bookWith = e.target.value || null;
            void save({ bookWith }, { ...data, bookWith });
          }}
        >
          <option value="">None: LUME books calls on Google Calendar only</option>
          {bookable.map((l) => (
            <option key={l.uri} value={l.uri}>
              {l.name} ({l.duration} min)
            </option>
          ))}
        </select>
        <small className={s.linkSub}>
          Schedule a meeting can book on it: Calendly sends the lead its own invite and reminders.
        </small>
      </div>
      {notBookable.length > 0 && (
        <ul className={s.cant} aria-label="Links LUME can't book on">
          {notBookable.map((l) => (
            <li key={l.uri}>
              <b>{l.name}</b>: {l.why}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className={s.err}>
          {error}
        </p>
      )}
    </section>
  );
}
