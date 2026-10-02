"use client";
import { useSyncExternalStore } from "react";

/** A phone: under 700 px wide (Phase 5 canvas, Phone). */
export const PHONE_QUERY = "(max-width: 699px)";

const subscribe = (onChange: () => void) => {
  const q = window.matchMedia(PHONE_QUERY);
  q.addEventListener?.("change", onChange);
  return () => q.removeEventListener?.("change", onChange);
};

/** Whether the window is phone-sized now; the server, and the first paint, assume it isn't. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}
