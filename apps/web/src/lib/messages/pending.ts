"use client";

/**
 * "Sent?" outlives the sheet it was asked from (4A inherited minor): WhatsApp was opened for a lead, and
 * LUME asks when the person is back — however they come back (window focus, the tab shown again, the page
 * restored), and wherever they are by then. The send sheet that opened it asks if it's still on screen;
 * otherwise the shell's PendingSent does, naming the lead.
 */
export type Pending = { leadId: string; leadName: string; taskId?: string; by: symbol };

let pending: Pending | null = null;
/** Send sheets on screen: the one that opened WhatsApp asks, rather than the shell. */
const sheets = new Set<symbol>();
const listeners = new Set<(p: Pending, bySheet: boolean) => void>();
let watching = false;

function back() {
  if (!pending) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const p = pending;
  pending = null;
  const bySheet = sheets.has(p.by);
  for (const l of listeners) l(p, bySheet);
}
function watch() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("focus", back);
  window.addEventListener("pageshow", back);
  document.addEventListener("visibilitychange", back);
}

/** WhatsApp was opened for this lead, by this sheet: ask when they're back. */
export function markAway(p: Pending): void {
  pending = p;
  watch();
}

/** A send sheet on screen. Returns the way to say it's gone. */
export function sheetShown(by: symbol): () => void {
  sheets.add(by);
  return () => void sheets.delete(by);
}

/** Told when they're back: which send, and whether the sheet that opened it is on screen to ask. */
export function onBack(listener: (p: Pending, bySheet: boolean) => void): () => void {
  listeners.add(listener);
  watch();
  return () => void listeners.delete(listener);
}
