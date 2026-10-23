"use client";
import { useEffect, useRef } from "react";
import type { NotificationView } from "./client";

type Listener = (n: NotificationView) => void;
const listeners = new Set<Listener>();
/** Told when leads changed somewhere (4B): no data, each asks for what it needs under its own access. */
const leadListeners = new Set<() => void>();
/** A change in a LUME AI run (Autopilot A2): its run, lead and kind; the screen reads the rest under its own access. */
export type AutopilotEvent = { run: string; lead: string | null; kind: string };
const autopilotListeners = new Set<(e: AutopilotEvent) => void>();
const anyone = () => listeners.size + leadListeners.size + autopilotListeners.size > 0;
let source: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
/** Connected once already: an open after that is a reconnection, and leads may have changed meanwhile. */
let connectedBefore = false;
/** The last id seen, to resume from; and the ids already passed on (a replay overlaps; 3A final review). */
let lastId = 0;
const seen = new Set<number>();
const SEEN_MAX = 500;

function open() {
  if (typeof EventSource === "undefined") return;
  const s = new EventSource(lastId ? `/api/v1/stream?after=${lastId}` : "/api/v1/stream");
  source = s;
  // Back after a drop (the browser's own retry, or LUME's): what changed meanwhile was never said.
  s.addEventListener("open", () => {
    if (connectedBefore) for (const l of leadListeners) l();
    connectedBefore = true;
    failures = 0;
  });
  s.addEventListener("leads", () => {
    failures = 0;
    for (const l of leadListeners) l();
  });
  s.addEventListener("autopilot", (e) => {
    let ev: Partial<AutopilotEvent>;
    try {
      ev = JSON.parse((e as MessageEvent<string>).data) as Partial<AutopilotEvent>;
    } catch {
      return;
    }
    if (typeof ev.run !== "string" || typeof ev.kind !== "string") return;
    failures = 0;
    const said: AutopilotEvent = {
      run: ev.run,
      lead: typeof ev.lead === "string" ? ev.lead : null,
      kind: ev.kind,
    };
    for (const l of autopilotListeners) l(said);
  });
  s.addEventListener("notification", (e) => {
    let n: NotificationView;
    try {
      n = JSON.parse((e as MessageEvent<string>).data) as NotificationView;
    } catch {
      return;
    }
    failures = 0;
    lastId = Math.max(lastId, n.id);
    if (seen.has(n.id)) return;
    seen.add(n.id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
    for (const l of listeners) l(n);
  });
  // The browser retries a dropped connection itself, but gives up for good on an error answer (a 502 while
  // the API restarts). Then LUME opens a new one, from where it was, backing off to 30 s (Important 4).
  s.onerror = () => {
    if (s.readyState !== EventSource.CLOSED || source !== s || !anyone()) return;
    clearTimeout(retry);
    retry = setTimeout(
      () => {
        if (source === s && anyone()) open();
      },
      Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)),
    );
  };
}

/**
 * One live stream per tab (Phase 3 spec §3 Live updates), shared by everything listening. Nothing missed
 * while offline is lost (it resumes from the last id), and nothing reaches a listener twice.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!source) open();
  return () => {
    listeners.delete(listener);
    closeIfUnused();
  };
}
function closeIfUnused() {
  if (anyone()) return;
  clearTimeout(retry);
  source?.close();
  source = null;
}

/** Leads changed somewhere (4B): on the tab's one stream, shared with notifications. */
export function subscribeLeads(listener: () => void): () => void {
  leadListeners.add(listener);
  if (!source) open();
  return () => {
    leadListeners.delete(listener);
    closeIfUnused();
  };
}

/**
 * Calls `on` when leads change, so counts stay true without polling (spec §3 View counts). A hidden tab
 * doesn't ask; it asks once when it's shown again.
 */
export function useLeadsChanged(on: () => void): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => {
    let stale = false;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const off = subscribeLeads(() => (hidden() ? (stale = true) : latest.current()));
    const shown = () => {
      if (!hidden() && stale) {
        stale = false;
        latest.current();
      }
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      off();
      document.removeEventListener("visibilitychange", shown);
    };
  }, []);
}

/** Calls `on` for every notification that arrives while the component is mounted. */
export function useStream(on: Listener): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => subscribe((n) => latest.current(n)), []);
}

/** LUME AI's runs changing (Autopilot A2), on the tab's one stream. */
export function subscribeAutopilot(listener: (e: AutopilotEvent) => void): () => void {
  autopilotListeners.add(listener);
  if (!source) open();
  return () => {
    autopilotListeners.delete(listener);
    closeIfUnused();
  };
}

/** Calls `on` for each change in a LUME AI run while the component is mounted (the Autopilot page, A3). */
export function useAutopilot(on: (e: AutopilotEvent) => void): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => subscribeAutopilot((e) => latest.current(e)), []);
}
