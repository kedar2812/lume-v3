"use client";
import { useEffect } from "react";

/**
 * The leads whose WhatsApp chat is on screen in this tab (2026-11-01): a message from one of them is already in view, so
 * no notice pops up for it. Counted, so two views of one chat (a drawer and LUME AI) both have to close.
 */
const open = new Map<string, number>();

export function isChatOpen(leadId: string): boolean {
  return (open.get(leadId) ?? 0) > 0;
}

/** Marks a lead's chat as on screen while `leadId` is set and the component is mounted. */
export function useChatOnScreen(leadId: string | null): void {
  useEffect(() => {
    if (!leadId) return;
    open.set(leadId, (open.get(leadId) ?? 0) + 1);
    return () => {
      const n = (open.get(leadId) ?? 1) - 1;
      if (n > 0) open.set(leadId, n);
      else open.delete(leadId);
    };
  }, [leadId]);
}
