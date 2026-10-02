"use client";

/**
 * The near-limit notice (6A, spec §2.6): when a reveal or an opened lead comes back near a rule's limit, LUME says
 * once an hour, calmly, that admins hear about unusual activity. No meter and no numbers: showing how far is
 * left would tell a scraper exactly how far to go.
 */
const listeners = new Set<() => void>();
let pending: string | null = null;

const hourKey = () => `lume.watch.notice.${new Date().toISOString().slice(0, 13)}`;
function shownThisHour(): boolean {
  try {
    return sessionStorage.getItem(hourKey()) === "1";
  } catch {
    return false;
  }
}

/** Raised by the leads client when a response says the person is near a limit. */
export function noteNearLimit(): void {
  if (shownThisHour()) return;
  pending = hourKey();
  for (const l of listeners) l();
}

/** Taken by the notice when it shows: it won't show again this hour, in this tab. */
export function takeNearLimit(): boolean {
  if (pending !== hourKey() || shownThisHour()) return false;
  pending = null;
  try {
    sessionStorage.setItem(hourKey(), "1");
  } catch {
    // Private mode: it may show again this hour, which is harmless.
  }
  return true;
}

export function onNearLimit(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** Tests only. */
export function resetNearLimitForTests(): void {
  pending = null;
}
