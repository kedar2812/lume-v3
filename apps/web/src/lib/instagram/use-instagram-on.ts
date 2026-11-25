"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** How long a page trusts what it was told (Instagram is switched in Settings, rarely). */
const FRESH_MS = 60_000;
let asked: { at: number; on: Promise<boolean> } | null = null;
const listeners = new Set<(on: boolean) => void>();

/** Instagram was just switched (Settings → Integrations): every place showing its flows hears it at once. */
export function instagramSwitched(on: boolean): void {
  asked = { at: Date.now(), on: Promise.resolve(on) };
  for (const l of listeners) l(on);
}

/** Tests only: forget the last answer. */
export function forgetInstagramOn(): void {
  asked = null;
}

function instagramOn(): Promise<boolean> {
  if (asked && Date.now() - asked.at < FRESH_MS) return asked.on;
  // The flows list answers only while Instagram is in the plan and on (INSTAGRAM_OFF otherwise).
  const on = api.get<{ flows: unknown[] }>("/api/v1/instagram/flows").then((r) => {
    // A failed read that isn't "off" isn't kept: the next one asks again.
    if (!r.ok && r.status !== 409 && r.status !== 403 && asked?.on === on) asked = null;
    return r.ok;
  });
  asked = { at: Date.now(), on };
  return on;
}

/**
 * Whether Instagram's flows are there for this person (plan 2026-11-25-instagram-screens D3): someone who may build
 * flows, on a LUME with Instagram on. Asked once a minute at most, however many places want to know (the sidebar, the
 * phone's tabs). Off until it's known, and off when it can't be.
 */
export function useInstagramOn(may: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!may) return setOn(false);
    let live = true;
    void instagramOn().then((v) => live && setOn(v));
    const hear = (v: boolean) => live && setOn(v);
    listeners.add(hear);
    return () => {
      live = false;
      listeners.delete(hear);
    };
  }, [may]);
  return on;
}
