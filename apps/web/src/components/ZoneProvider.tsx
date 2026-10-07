"use client";
import { createContext, useContext, type ReactNode } from "react";

const Zone = createContext<string | null>(null);

/** The person's zone (own, else the business's), given once by the app's layout from the session. */
export function ZoneProvider({ zone, children }: { zone: string; children: ReactNode }) {
  return <Zone.Provider value={zone}>{children}</Zone.Provider>;
}

/** The zone this person's dates and times are read in; outside the app (tests, previews), this browser's. */
export function useZone(): string {
  return useContext(Zone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}
