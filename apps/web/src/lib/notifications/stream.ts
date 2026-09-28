"use client";
import { useEffect, useRef } from "react";
import type { NotificationView } from "./client";

type Listener = (n: NotificationView) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

/**
 * One live stream per tab (Phase 3 spec §3 Live updates), shared by everything listening. The browser
 * reconnects it on its own and sends Last-Event-ID, so nothing missed while offline is lost or repeated.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!source && typeof EventSource !== "undefined") {
    source = new EventSource("/api/v1/stream");
    source.addEventListener("notification", (e) => {
      let n: NotificationView;
      try {
        n = JSON.parse((e as MessageEvent<string>).data) as NotificationView;
      } catch {
        return;
      }
      for (const l of listeners) l(n);
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
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
