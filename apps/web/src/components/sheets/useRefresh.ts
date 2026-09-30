"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { sheetsClient } from "@/lib/sheets/client";
import type { RefreshProgress } from "@/lib/sheets/types";

/** The v5 motion's beats, in ms (docs/design/refresh-sync-v5.html). */
export const TIMING = {
  lift: 540,
  minOpen: 900,
  poll: 300,
  result: 1300,
  land: 620,
  landed: 1600,
  giveUp: 90_000,
} as const;
export type Phase = "idle" | "lifting" | "syncing" | "result" | "landing" | "landed";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** "a minute", "5 minutes", "an hour": when LUME tries again. */
export function waitWords(s: number | null): string {
  if (s === null || s < 90) return "a minute";
  if (s >= 3300) return "an hour";
  return `${Math.round(s / 60)} minutes`;
}

/** The card's title when a Refresh didn't happen: what stopped it, in a few words (by the API's code). */
export function failureTitle(code: string | null, unreachable: boolean): string {
  if (code === "SHEETS_OFF") return "Google Sheets is off";
  if (code === "NO_SHEETS") return "No sheet to refresh";
  if (code === "OFFLINE") return "You're offline";
  if (unreachable) return "Couldn't reach Google";
  return "Couldn't refresh";
}

/** The one sentence the moment ends with, spoken once (spec §8.2). */
export function resultLine(p: RefreshProgress | null, failure: string | null, personal: boolean): string {
  if (failure) return failure;
  if (!p) return "Up to date";
  if (p.unreachable) return `Couldn't reach Google. LUME will try again in ${waitWords(p.retryInS)}.`;
  if (p.status !== "done") return "Still bringing leads in — they'll appear as they arrive.";
  if (!p.created && !p.merged) return "Up to date";
  const parts = [
    p.created ? `${plural(p.created, "new lead", "new leads")}${personal ? " for you" : ""}` : null,
    p.merged ? `${p.merged.toLocaleString("en")} merged into existing ones` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * Spec §8: press → lift → sync (polling real progress, never less than a beat so it reads) → the result →
 * back into the button → "✓ N new" → Refresh. One press at a time; polling pauses while the tab is hidden.
 */
export function useRefresh(o: { reduce: boolean; personal: boolean; onArrived(p: RefreshProgress): void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<RefreshProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [failCode, setFailCode] = useState<string | null>(null);
  /** Sheets that need attention, from the last Refresh: kept until the next press. */
  const [attention, setAttention] = useState<RefreshProgress["attention"]>([]);
  const [announce, setAnnounce] = useState("");
  const alive = useRef(true);
  const busy = useRef(false);
  const arrived = useRef(o.onArrived);
  arrived.current = o.onArrived;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const press = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const opened = Date.now();
    setProgress(null);
    setFailure(null);
    setFailCode(null);
    setAttention([]);
    setPhase("lifting");
    setAnnounce("Syncing new enquiries");
    const [r] = await Promise.all([sheetsClient.refresh(), wait(o.reduce ? 0 : TIMING.lift)]);
    if (!alive.current) return;
    setPhase("syncing");
    let last: RefreshProgress | null = null;
    let failed: string | null = null;
    let code: string | null = null;
    if (!r.ok) {
      code = r.code;
      failed = r.code === "OFFLINE" ? "LUME will sync when you're back." : r.message;
    } else {
      const until = Date.now() + TIMING.giveUp;
      while (Date.now() < until) {
        await wait(TIMING.poll);
        if (!alive.current) return;
        if (document.visibilityState === "hidden") continue;
        const p = await sheetsClient.progress(r.data.id);
        if (!alive.current) return;
        if (p.ok) {
          last = p.data;
          setProgress(p.data);
          if (p.data.status === "done") break;
        }
      }
    }
    const held = Date.now() - opened;
    const floor = (o.reduce ? 0 : TIMING.lift) + TIMING.minOpen;
    if (held < floor) await wait(floor - held);
    if (!alive.current) return;
    setFailure(failed);
    setFailCode(code);
    setPhase("result");
    const needs = last?.attention ?? [];
    setAttention(needs);
    const title = failed ? `${failureTitle(code, false)}. ` : "";
    setAnnounce(
      [title + resultLine(last, failed, o.personal), ...needs.map((a) => `“${a.name}” needs attention`)].join(
        ". ",
      ),
    );
    await wait(TIMING.result);
    if (!alive.current) return;
    setPhase("landing");
    if (last) arrived.current(last);
    await wait(o.reduce ? 200 : TIMING.land);
    if (!alive.current) return;
    setPhase("landed");
    await wait(TIMING.landed);
    if (!alive.current) return;
    setPhase("idle");
    busy.current = false;
  }, [o.reduce, o.personal]);

  return { phase, progress, failure, failCode, attention, announce, press };
}
