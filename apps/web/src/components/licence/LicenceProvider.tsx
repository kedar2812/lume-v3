"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { can } from "@lume/core/shared";
import { LICENCE_REFUSED, licenceClient, type LicenceForPerson } from "@/lib/licence/client";
import type { Session } from "@/server/session";

type LicenceContext = {
  licence: LicenceForPerson;
  /** May download Export all data (the data.export permission). */
  canExport: boolean;
  refresh(): Promise<void>;
  set(l: LicenceForPerson): void;
};
const Ctx = createContext<LicenceContext | null>(null);

/** How long after the app opens LUME looks at the licence once more (a sign-in's own check may have finished). */
const LOOK_AGAIN_MS = 4000;

/**
 * The licence as this person sees it (licensing L-A), for the shell's banner, lock screen and reminder and
 * for Settings → About. It starts from the session (so nothing flashes), looks again once a few seconds
 * later, and whenever the API refuses something for the licence.
 */
export function LicenceProvider({ session, children }: { session: Session; children: ReactNode }) {
  const [licence, set] = useState<LicenceForPerson>(session.licence);
  const refresh = useCallback(async () => {
    const r = await licenceClient.get();
    if (r.ok) set(r.data);
  }, []);
  useEffect(() => {
    if (session.licence.dev) return;
    const t = setTimeout(() => void refresh(), LOOK_AGAIN_MS);
    const refused = () => void refresh();
    window.addEventListener(LICENCE_REFUSED, refused);
    return () => {
      clearTimeout(t);
      window.removeEventListener(LICENCE_REFUSED, refused);
    };
  }, [refresh, session.licence.dev]);
  return (
    <Ctx.Provider value={{ licence, canExport: can(session.actor, "data.export"), refresh, set }}>
      {children}
    </Ctx.Provider>
  );
}

export function useLicence(): LicenceContext {
  const c = useContext(Ctx);
  if (!c) throw new Error("useLicence outside a LicenceProvider");
  return c;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "26 Sep" (this year) or "12 Mar 2027", from an ISO date or moment, as the calendar reads it (UTC). */
export function day(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  const y = d.getUTCFullYear();
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${y === new Date().getUTCFullYear() ? "" : ` ${y}`}`;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "Just now", "12 minutes ago", "2 hours ago", "3 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${plural(Math.floor(s / 60), "minute")} ago`;
  if (s < 86_400) return `${plural(Math.floor(s / 3600), "hour")} ago`;
  return `${plural(Math.floor(s / 86_400), "day")} ago`;
}
/** "for 2 days", "for 30 hours": how long something has been so. */
export function sinceWords(iso: string, now = Date.now()): string {
  const h = Math.max(0, (now - Date.parse(iso)) / 3_600_000);
  return h < 48 ? plural(Math.max(1, Math.floor(h)), "hour") : plural(Math.floor(h / 24), "day");
}
/** "in 3 h 58 m", "in 12 m": when the next check is. */
export function until(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  const h = Math.floor(m / 60);
  return h ? `in ${h} h ${m % 60} m` : `in ${m} m`;
}
