"use client";
import { useEffect, useState } from "react";

/** "just now", "2 min ago", "3 h ago", "2 d ago": how long since `iso`, at `now`. */
export function agoWords(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const mins = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

/**
 * The same, kept true as time passes (every 20 s) and the moment `iso` changes: a Refresh that just read the calendar
 * says "just now" at once, not what the page said when it opened.
 */
export function useAgo(iso: string | null): string | null {
  const [words, setWords] = useState(() => agoWords(iso, new Date()));
  useEffect(() => {
    // Only a change of words renders again ("2 min ago" → "3 min ago"), never every tick.
    const look = () => setWords(agoWords(iso, new Date()));
    look();
    const t = setInterval(look, 20_000);
    return () => clearInterval(t);
  }, [iso]);
  return words;
}
