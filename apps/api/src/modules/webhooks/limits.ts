export type Verdict = { ok: true } | { ok: false; retryAfterSec: number; first: boolean };
export type Limiter = {
  /** Every post, before anything is looked up: a flood's ceiling, so a flood never reaches the database. */
  gate(): Verdict;
  /** A webhook that exists: its own share, spent before its secret is checked. */
  source(id: string): Verdict;
  /** A post that proved itself: the instance's share is spent only by real senders (final review, 3). */
  instance(): Verdict;
  /** How many windows are remembered (tests). */
  size(): number;
};

type Window = { start: number; count: number; refused: boolean };
const GATE = "\u0000gate";
const INSTANCE = "\u0000instance";

/**
 * 2C spec §2 Rate: fixed windows, in memory, because one API process serves an instance (a second process
 * would each allow the full rate). At most `maxKeys` windows are kept, the least recently used going first,
 * so no stream of addresses can grow it (final review, Important 2).
 */
export function createLimiter(o: {
  perSource: number;
  perInstance: number;
  windowMs: number;
  /** The gate's share a window; five times the instance's by default. */
  perGate?: number;
  maxKeys?: number;
  now?: () => number;
}): Limiter {
  const now = o.now ?? Date.now;
  const maxKeys = o.maxKeys ?? 10_000;
  const windows = new Map<string, Window>();
  const take = (key: string, max: number): Verdict => {
    const t = now();
    let w = windows.get(key);
    if (w) windows.delete(key); // re-inserted below: the Map's order is least recently used first
    if (!w || t - w.start >= o.windowMs) w = { start: t, count: 0, refused: false };
    windows.set(key, w);
    if (windows.size > maxKeys) windows.delete(windows.keys().next().value!);
    if (w.count < max) {
      w.count++;
      return { ok: true };
    }
    const first = !w.refused;
    w.refused = true;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + o.windowMs - t) / 1000)), first };
  };
  return {
    gate: () => take(GATE, o.perGate ?? o.perInstance * 5),
    source: (id) => take(id, o.perSource),
    instance: () => take(INSTANCE, o.perInstance),
    size: () => windows.size,
  };
}
