/**
 * A fixed-window counter per key (an instance, an address), in memory: the licence server is one process.
 * Windows that have passed are swept as it goes, so it never grows past the keys seen in one window.
 */
export class Limiter {
  private readonly hits = new Map<string, { start: number; n: number }>();
  private swept = 0;

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  get size(): number {
    return this.hits.size;
  }

  take(key: string, nowMs: number): { ok: true } | { ok: false; retryAfterS: number } {
    if (nowMs - this.swept >= this.windowMs) {
      for (const [k, w] of this.hits) if (nowMs - w.start >= this.windowMs) this.hits.delete(k);
      this.swept = nowMs;
    }
    let w = this.hits.get(key);
    if (!w || nowMs - w.start >= this.windowMs) {
      w = { start: nowMs, n: 0 };
      this.hits.set(key, w);
    }
    if (w.n >= this.max)
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((w.start + this.windowMs - nowMs) / 1000)) };
    w.n++;
    return { ok: true };
  }
}
