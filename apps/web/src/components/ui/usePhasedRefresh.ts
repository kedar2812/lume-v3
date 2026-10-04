"use client";
import { useCallback, useRef, useState } from "react";
import type { RefreshPhase } from "./RefreshMorph";

/** The v5 motion's beats, in ms (docs/design/refresh-sync-v5.html), as the Sheets and Calendar Refresh use them. */
const BEAT = { lift: 540, minOpen: 900, result: 1300, land: 620, landed: 1600 } as const;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Refresh moment for anything that reloads in one go (Leads and the board without a sheet, Analytics): press →
 * the button lifts into the pill → the card while the work runs (never shorter than a beat, so it reads) → the
 * result → back into the button → "✓ …" → Refresh. One press at a time. Reduce Motion skips straight to the result.
 */
export function usePhasedRefresh<T>(o: { reduce: boolean; run(): Promise<T>; announce(r: T): string }) {
  const [phase, setPhase] = useState<RefreshPhase>("idle");
  const [result, setResult] = useState<T | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const busy = useRef(false);
  const { reduce, run, announce } = o;

  const press = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setFailure(null);
    setSaid("");
    try {
      setPhase("lifting");
      if (!reduce) await wait(BEAT.lift);
      setPhase("syncing");
      const started = Date.now();
      let out: T | null = null;
      try {
        out = await run();
      } catch (e) {
        setFailure(e instanceof Error ? e.message : "Couldn't refresh");
      }
      const left = BEAT.minOpen - (Date.now() - started);
      if (left > 0 && !reduce) await wait(left);
      setResult(out);
      setSaid(out === null ? "Couldn't refresh. Try again in a moment." : announce(out));
      setPhase("result");
      await wait(reduce ? 600 : BEAT.result);
      setPhase("landing");
      if (!reduce) await wait(BEAT.land);
      setPhase("landed");
      await wait(BEAT.landed);
      setPhase("idle");
    } finally {
      busy.current = false;
    }
  }, [reduce, run, announce]);

  return { phase, result, failure, said, press };
}
