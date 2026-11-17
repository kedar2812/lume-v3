"use client";
import { useEffect, useRef } from "react";
import { leadsClient } from "./client";
import type { Lead } from "./types";

/**
 * One lead changed outside the screen showing it (the shell's "Sent?" moving its stage): the screen reads that lead
 * again and shows it as it is now, without reloading the whole list (bug hunt 2026-11-17).
 */
const LEAD_UPDATED = "lume:lead-updated";

export function announceLeadUpdated(leadId: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(LEAD_UPDATED, { detail: leadId }));
}

export function useLeadUpdated(on: (lead: Lead) => void): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => {
    const heard = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id) return;
      void leadsClient.get(id).then((r) => r.ok && latest.current(r.data.lead));
    };
    window.addEventListener(LEAD_UPDATED, heard);
    return () => window.removeEventListener(LEAD_UPDATED, heard);
  }, []);
}
