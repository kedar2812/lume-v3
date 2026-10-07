import { timeOf } from "@/lib/dates";

/**
 * "Sep 22, 2026" (or "Sep 22"): month first, as everywhere in LUME, on the person's clock (`tz`) — so the server's
 * render and the browser's agree, and a rep abroad reads their own day.
 */
export function settingsDate(iso: string, tz: string, withYear = true): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(iso));
}

/** "Sep 22, 2:05 pm": a moment, in LUME's words, on the person's clock. */
export function settingsDateTime(iso: string, tz: string): string {
  return `${settingsDate(iso, tz, false)}, ${timeOf(new Date(iso), tz)}`;
}
