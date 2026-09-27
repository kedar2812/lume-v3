"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { sheetsClient } from "@/lib/sheets/client";

/** Spec §8.3: new rows glow for 5 s, 70 ms apart; at most 20 glow. */
export const GLOW_MS = 5000;
export const STAGGER_MS = 70;
const MAX = 20;

/**
 * What arrived since this person last looked at Leads (per viewer, per visit, never stored), and a flash
 * for what a Refresh just brought in. Leaving Leads or hiding the tab marks it seen, on the server's clock.
 */
export function useArrivals() {
  const [glowing, setGlowing] = useState<Map<string, number>>(new Map());
  const [count, setCount] = useState(0);
  const [since, setSince] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((ids: string[]) => {
    const list = ids.slice(0, MAX);
    setGlowing(new Map(list.map((id, i) => [id, i])));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setGlowing(new Map()), GLOW_MS + list.length * STAGGER_MS);
  }, []);

  useEffect(() => {
    let live = true;
    void sheetsClient.arrivals().then((r) => {
      if (!live || !r.ok) return;
      setSince(r.data.since);
      setCount(r.data.count);
      if (r.data.ids.length) flash(r.data.ids);
    });
    const seen = () => void sheetsClient.seen();
    const onHide = () => {
      if (document.visibilityState === "hidden") seen();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onHide);
      if (timer.current) clearTimeout(timer.current);
      seen();
    };
  }, [flash]);

  return { glowing, count, since, flash };
}
