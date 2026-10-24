"use client";
import { useEffect, useState } from "react";
import { aiClient } from "./client";

/** How long a page trusts what it was told (LUME AI is switched in Settings, rarely). */
const FRESH_MS = 60_000;
let asked: { at: number; on: Promise<boolean> } | null = null;

/** Tests only: forget the last answer. */
export function forgetAiOn(): void {
  asked = null;
}

function aiOn(): Promise<boolean> {
  if (asked && Date.now() - asked.at < FRESH_MS) return asked.on;
  const on = aiClient.status().then((r) => {
    // A failed read isn't kept: the next one asks again.
    if (!r.ok) asked = null;
    return r.ok && r.data.on;
  });
  asked = { at: Date.now(), on };
  return on;
}

/**
 * Whether LUME AI is on for this person (Autopilot A3): asked once a minute at most, however many places want to know
 * (the island's "Let LUME AI handle these", the Autopilot nav item). Off until it's known, and off when it can't be.
 */
export function useAiOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void aiOn().then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, []);
  return on;
}
