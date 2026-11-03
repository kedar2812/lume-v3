"use client";
import { useEffect } from "react";

/**
 * The leads whose WhatsApp chat is on screen in this tab (2026-11-01): a message from one of them is already in view, so
 * no notice pops up for it. Counted, so two views of one chat (a drawer and LUME AI) both have to close.
 */
const open = new Map<string, number>();
/** Told when a lead's chat comes on screen: a notice already up for them goes (gate 2026-11-04). */
const opened = new Set<(leadId: string) => void>();

/** Hears each chat as it comes on screen; returns the way to stop. */
export function onChatOpened(fn: (leadId: string) => void): () => void {
  opened.add(fn);
  return () => void opened.delete(fn);
}

export function isChatOpen(leadId: string): boolean {
  return (open.get(leadId) ?? 0) > 0;
}

/** Marks a lead's chat as on screen while `leadId` is set and the component is mounted. */
export function useChatOnScreen(leadId: string | null): void {
  useEffect(() => {
    if (!leadId) return;
    open.set(leadId, (open.get(leadId) ?? 0) + 1);
    for (const fn of opened) fn(leadId);
    return () => {
      const n = (open.get(leadId) ?? 1) - 1;
      if (n > 0) open.set(leadId, n);
      else open.delete(leadId);
    };
  }, [leadId]);
}
