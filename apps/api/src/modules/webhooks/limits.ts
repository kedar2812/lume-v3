export type Limiter = { take(sourceId: string): { ok: true } | { ok: false; retryAfterSec: number } };

type Window = { start: number; count: number };
const INSTANCE = "i";
const MAX_KEYS = 10_000;

/**
 * 2C spec §2 Rate: fixed windows per source and for the whole instance. In memory, because one API
 * process serves an instance; a second process would each allow the full rate.
 */
export function createLimiter(o: {
  perSource: number;
  perInstance: number;
  windowMs: number;
  now?: () => number;
}): Limiter {
  const now = o.now ?? Date.now;
  const windows = new Map<string, Window>();
  const current = (key: string, t: number) => {
    let w = windows.get(key);
    if (!w || t - w.start >= o.windowMs) {
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    return w;
  };
  const wait = (w: Window, t: number) => Math.max(1, Math.ceil((w.start + o.windowMs - t) / 1000));
  return {
    take(sourceId) {
      const t = now();
      if (windows.size > MAX_KEYS)
        for (const [k, w] of windows) if (t - w.start >= o.windowMs) windows.delete(k);
      const all = current(INSTANCE, t);
      const one = current(sourceId, t);
      if (all.count >= o.perInstance) return { ok: false, retryAfterSec: wait(all, t) };
      if (one.count >= o.perSource) return { ok: false, retryAfterSec: wait(one, t) };
      all.count++;
      one.count++;
      return { ok: true };
    },
  };
}
