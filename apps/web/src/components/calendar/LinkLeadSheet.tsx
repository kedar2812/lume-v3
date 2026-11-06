"use client";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { calendarClient } from "@/lib/calendar/client";
import type { Meeting } from "@/lib/calendar/types";
import { leadsClient } from "@/lib/leads/client";
import { EMPTY_FILTERS } from "@/lib/leads/filters";
import s from "./calendar.module.css";

type Found = { id: string; name: string };

/**
 * A call that isn't with a lead yet, linked to one already in LUME (client 2026-11-06: "can't add a lead from the
 * calendar call"): find them by name, phone or email, pick, and the call is theirs.
 */
export function LinkLeadSheet({
  meeting,
  onClose,
  onLinked,
}: {
  meeting: Meeting;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);

  useEffect(() => {
    const words = q.trim();
    if (words.length < 2) return setFound(null);
    const n = ++asked.current;
    const t = setTimeout(async () => {
      const r = await leadsClient.list({ ...EMPTY_FILTERS, q: words }, undefined, 8);
      if (n !== asked.current) return; // a later search is on its way
      if (!r.ok) return setError(r.message);
      setError(null);
      setFound(r.data.items.map((l) => ({ id: l.id, name: l.name ?? "Unnamed lead" })));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const link = async (leadId: string) => {
    setBusy(true);
    const r = await calendarClient.patchMeeting(meeting.id, { leadId });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    onLinked();
  };

  return (
    <Dialog label={`Link “${meeting.title}” to a lead`} onClose={onClose} wide>
      <h2 className={s.linkTitle}>Link to a lead</h2>
      <p className={s.linkLede}>
        Find the person this call is with. The call shows on their lead from now on.
      </p>
      <input
        type="search"
        aria-label="Find a lead"
        className={s.linkSearch}
        placeholder="Name, phone or email"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      {error && (
        <p role="alert" className={s.linkError}>
          {error}
        </p>
      )}
      {found && found.length === 0 && <p className={s.linkLede}>No lead matches “{q.trim()}”.</p>}
      {found && found.length > 0 && (
        <ul className={s.linkList} aria-label="Leads found">
          {found.map((l) => (
            <li key={l.id}>
              <button type="button" className={s.linkPick} disabled={busy} onClick={() => void link(l.id)}>
                {l.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
