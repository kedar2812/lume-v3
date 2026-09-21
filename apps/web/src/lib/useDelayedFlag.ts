"use client";
import { useEffect, useState } from "react";

/** True only once `active` has stayed true for `delayMs`. Skeletons for fast loads would just flash (spec §5.3). */
export function useDelayedFlag(active: boolean, delayMs = 150): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);
  return active && on;
}
