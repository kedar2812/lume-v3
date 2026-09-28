"use client";
import { useEffect, useRef } from "react";
import type { NotificationView } from "./client";

type Listener = (n: NotificationView) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
/** The last id seen, to resume from; and the ids already passed on (a replay overlaps; 3A final review). */
let lastId = 0;
const seen = new Set<number>();
const SEEN_MAX = 500;

function open() {
  if (typeof EventSource === "undefined") return;
  const s = new EventSource(lastId ? `/api/v1/stream?after=${lastId}` : "/api/v1/stream");
  source = s;
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
    if (s.readyState !== EventSource.CLOSED || source !== s || !listeners.size) return;
    clearTimeout(retry);
    retry = setTimeout(
      () => {
        if (source === s && listeners.size) open();
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
    if (!listeners.size) {
      clearTimeout(retry);
      source?.close();
      source = null;
    }
  };
}

/** Calls `on` for every notification that arrives while the component is mounted. */
export function useStream(on: Listener): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => subscribe((n) => latest.current(n)), []);
}
