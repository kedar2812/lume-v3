"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefreshPhase } from "@/components/ui/RefreshMorph";
import { calendarClient } from "@/lib/calendar/client";
import type { LastSync } from "@/lib/calendar/types";

/** The beats, in ms: the leads Refresh's, with the calendar's slower poll (the sync runs on the server). */
export const TIMING = {
  lift: 540,
  minOpen: 900,
  poll: 1200,
  result: 1300,
  land: 620,
  landed: 1600,
  giveUp: 30_000,
};

export const STILL_SYNCING = "Still syncing. Refresh again in a minute to see it.";
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the sync changed, newest kind first: "1 new meeting · 1 moved · 2 updated", else "Up to date". */
export function syncWords(l: LastSync): string {
  const parts = [
    l.added ? plural(l.added, "new meeting", "new meetings") : null,
    l.moved ? `${l.moved} moved` : null,
    l.changed ? `${l.changed} updated` : null,
    l.cancelled ? `${l.cancelled} cancelled` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Up to date";
}

/** What the button lands on: "✓ 3 updated", "✓ Up to date", or (no sync came back in time) "Still syncing". */
export function landedWords(l: LastSync | null): string {
  if (!l) return "Still syncing";
  const total = l.added + l.moved + l.changed + l.cancelled;
  return total ? `${total} updated` : "Up to date";
}

/**
 * Refresh for the calendar (5D Task 6): press → lift → sync (wait for a sync newer than the press, polling
 * the connection) → the result → back into the button. A sync already running is waited on, not failed
 * (the server leaves the connection due again). A grant Google withdrew turns the button into Connect again.
 */
export function useCalendarRefresh(o: {
  reduce: boolean;
  needsReconnect: boolean;
  onSynced(l: LastSync): void;
}) {
  const [phase, setPhase] = useState<RefreshPhase>("idle");
  const [last, setLast] = useState<LastSync | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(o.needsReconnect);
  const [announce, setAnnounce] = useState("");
  const alive = useRef(true);
  const busy = useRef(false);
  const synced = useRef(o.onSynced);
  synced.current = o.onSynced;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => setReconnect(o.needsReconnect), [o.needsReconnect]);

  const press = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const opened = Date.now();
    setLast(null);
    setFailure(null);
    setPhase("lifting");
    setAnnounce("Syncing your calendar");
    const [r] = await Promise.all([calendarClient.sync(), wait(o.reduce ? 0 : TIMING.lift)]);
    if (!alive.current) return;
    setPhase("syncing");
    let got: LastSync | null = null;
    let failed: string | null = null;
    if (!r.ok) {
      failed = r.message;
      if (r.code === "CALENDAR_NEEDS_RECONNECT") setReconnect(true);
    } else {
      const since = Date.parse(r.data.since);
      const until = Date.now() + TIMING.giveUp;
      while (Date.now() < until) {
        await wait(TIMING.poll);
        if (!alive.current) return;
        if (document.visibilityState === "hidden") continue;
        const c = await calendarClient.connection();
        if (!alive.current) return;
        if (!c.ok || !c.data.connected) continue;
        if (c.data.status === "needs_reconnect") {
          failed = c.data.lastError ?? "Google stopped letting LUME read your calendar. Connect it again.";
          setReconnect(true);
          break;
        }
        if (c.data.lastSync && Date.parse(c.data.lastSync.at) > since) {
          got = c.data.lastSync;
          break;
        }
        // The sync this press asked for failed (Google busy, say): say so now, not after 30 s of waiting.
        if (c.data.lastFailedAt && Date.parse(c.data.lastFailedAt) > since) {
          failed = `${c.data.lastError ?? "LUME couldn't read your calendar."} LUME will try again on its own.`;
          break;
        }
      }
    }
    const held = Date.now() - opened;
    const floor = (o.reduce ? 0 : TIMING.lift) + TIMING.minOpen;
    if (held < floor) await wait(floor - held);
    if (!alive.current) return;
    setLast(got);
    setFailure(failed);
    setPhase("result");
    setAnnounce(failed ?? (got ? syncWords(got) : STILL_SYNCING));
    await wait(TIMING.result);
    if (!alive.current) return;
    setPhase("landing");
    if (got) synced.current(got);
    await wait(o.reduce ? 200 : TIMING.land);
    if (!alive.current) return;
    setPhase("landed");
    await wait(TIMING.landed);
    if (!alive.current) return;
    setPhase("idle");
    busy.current = false;
  }, [o.reduce]);

  return { phase, last, failure, reconnect, announce, press };
}
