"use client";
import type { NetWatch } from "./watch";

/**
 * The browser side of the connection notice: each API answer's trip from Resource Timing (the wait from sending to the
 * first byte, so the browser's own queue, a busy page and a big answer never count), less the time LUME says it spent
 * (its Server-Timing). Offline from the browser's own signal, or when a request or the live stream couldn't reach LUME
 * and a check of /healthz can't either: LUME restarting still answers (the edge's 502), so it never reads as offline.
 */

/** While offline, LUME checks again this often. */
export const PROBE_MS = 5000;
/** A check that hasn't answered in this long: the connection is down. */
export const PROBE_TIMEOUT_MS = 8000;
/**
 * One failed check is checked again this soon before LUME says offline: an update restarts LUME's edge for a few
 * seconds, and that refuses connections rather than answering (review 2026-11-27).
 */
export const CONFIRM_MS = 3000;

type Timing = Pick<
  PerformanceResourceTiming,
  "initiatorType" | "name" | "startTime" | "requestStart" | "responseStart" | "serverTiming"
>;

/** One answer's trip, or null when it can't say anything about the connection. */
export function tripOf(
  e: Timing,
  visibleSince: number,
  origin: string,
): { net: number; server: number } | null {
  // Uploads go by XMLHttpRequest (a file's size decides their time), files and pages aren't API answers.
  if (e.initiatorType !== "fetch") return null;
  let url: URL;
  try {
    url = new URL(e.name);
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.pathname.startsWith("/api/") || url.pathname.endsWith("/stream"))
    return null;
  // Started while the tab was in the background: the browser held it back on purpose.
  if (e.startTime < visibleSince) return null;
  const app = (e.serverTiming ?? []).find((t) => t.name === "app");
  if (!app || !(e.requestStart > 0) || !(e.responseStart > 0)) return null;
  return { net: Math.max(0, e.responseStart - e.requestStart - app.duration), server: app.duration };
}

let report: (() => void) | null = null;
/** A request or the live stream couldn't reach LUME: check whether the connection is down. */
export function unreachable(): void {
  report?.();
}

/** Starts watching; the returned function stops everything it started. */
export function startNetMonitor(watch: NetWatch): () => void {
  let stopped = false;
  let checking = false;
  /** Failed checks in a row. */
  let misses = 0;
  let again: ReturnType<typeof setTimeout> | undefined;
  let visibleSince = document.visibilityState === "visible" ? 0 : Infinity;

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    clearTimeout(again);
    let reached = false;
    try {
      const ctl = new AbortController();
      const cap = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
      try {
        await fetch("/healthz", { cache: "no-store", signal: ctl.signal });
        reached = true;
      } finally {
        clearTimeout(cap);
      }
    } catch {
      reached = false;
    }
    checking = false;
    if (stopped) return;
    if (reached) {
      misses = 0;
      if (watch.state() === "offline") watch.online();
      return;
    }
    misses += 1;
    if (watch.state() !== "offline") {
      // The browser still thinks it's online: once more, a moment later, before saying so.
      if (misses < 2 && navigator.onLine !== false) {
        again = setTimeout(() => void check(), CONFIRM_MS);
        return;
      }
      watch.offline();
    }
    again = setTimeout(() => void check(), PROBE_MS);
  };

  const onOffline = () => {
    watch.offline();
    clearTimeout(again);
    again = setTimeout(() => void check(), PROBE_MS);
  };
  // The browser says it's back: make sure LUME answers before saying so.
  const onOnline = () => void check();
  const onVisible = () => {
    visibleSince = document.visibilityState === "visible" ? performance.now() : Infinity;
  };
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  report = () => void check();
  if (typeof navigator !== "undefined" && navigator.onLine === false) onOffline();

  let observer: PerformanceObserver | undefined;
  if (typeof PerformanceObserver !== "undefined") {
    try {
      observer = new PerformanceObserver((list) => {
        if (document.visibilityState !== "visible") return;
        for (const e of list.getEntries() as PerformanceResourceTiming[]) {
          const t = tripOf(e, visibleSince, window.location.origin);
          if (t) watch.trip(t.net, t.server);
        }
      });
      observer.observe({ type: "resource" });
    } catch {
      observer = undefined;
    }
  }

  return () => {
    stopped = true;
    clearTimeout(again);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    observer?.disconnect();
    report = null;
  };
}
