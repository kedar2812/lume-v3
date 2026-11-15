import type { DayKind } from "@/lib/today/day-items";
import type { Show } from "./DayList";

/** What the full-screen day remembers per person on this device (spec: "What it remembers"). */
export type DayPrefs = { view: "timeline" | "list"; show: Show; pph: number };

const KEY = "lume.yourDay";
const KINDS: DayKind[] = ["call", "follow_up"];
export const DEFAULT_PREFS: DayPrefs = { view: "timeline", show: "all", pph: 0 };

/** The remembered choices, or the defaults when there are none, they're unreadable, or storage is blocked. */
export function readPrefs(): DayPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<DayPrefs> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_PREFS;
    return {
      view: raw.view === "list" ? "list" : "timeline",
      show: raw.show === "all" || KINDS.includes(raw.show as DayKind) ? (raw.show as Show) : "all",
      pph: typeof raw.pph === "number" && Number.isFinite(raw.pph) && raw.pph >= 0 ? raw.pph : 0,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Remember the choices; a blocked storage just means they aren't remembered. */
export function writePrefs(p: DayPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private windows and blocked site data: nothing to do.
  }
}
