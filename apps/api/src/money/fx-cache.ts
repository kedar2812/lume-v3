import type { RateSource } from "./rates";

/** A day-old rate is plenty for "about" (open.er-api.com updates daily); a failure is tried again after a while. */
const KEEP_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;

type Kept = { rate: number | null; until: number };
const kept = new Map<string, Kept>();
const asking = new Map<string, Promise<void>>();

/**
 * An exchange rate for showing an estimate in the business currency (WhatsApp's cost, owner 2026-11-18): kept for
 * half a day. It never waits on the internet: it's read while a request holds its transaction (a template send, an
 * Autopilot step), so a rate not kept yet is asked for in the background, once however many want it, and this answer
 * is null: the caller shows the card's own currency rather than guess (review 2026-11-18). Only currency codes ever
 * leave the server.
 */
export function rateFor(
  source: RateSource | undefined,
  from: string,
  to: string,
  now = Date.now(),
): number | null {
  if (from === to) return 1;
  if (!source) return null;
  const key = `${from}:${to}`;
  const hit = kept.get(key);
  if (hit && hit.until > now) return hit.rate;
  if (!asking.has(key))
    asking.set(
      key,
      source
        .quote(from, to)
        .then(
          (q) => kept.set(key, { rate: q.rate > 0 ? q.rate : null, until: now + KEEP_MS }),
          () => kept.set(key, { rate: hit?.rate ?? null, until: now + RETRY_MS }),
        )
        .then(() => void asking.delete(key)),
    );
  // A rate kept before and now old still serves while the new one comes.
  return hit?.rate ?? null;
}

/** Tests only: the background ask, done. */
export async function ratesSettledForTests() {
  await Promise.all(asking.values());
}

/** Tests only. */
export function forgetRatesForTests() {
  kept.clear();
  asking.clear();
}
