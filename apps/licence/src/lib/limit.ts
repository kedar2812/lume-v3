/**
 * A fixed-window counter per key (an instance, an address), in memory: the licence server is one process.
 * Windows that have passed are swept as it goes, so it never grows past the keys seen in one window.
 */
export type Take = { ok: true } | { ok: false; retryAfterS: number; first: boolean };

export class Limiter {
  private readonly hits = new Map<string, { start: number; n: number; refused: boolean }>();
  private swept = 0;

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  get size(): number {
    return this.hits.size;
  }

  private window(key: string, nowMs: number) {
    if (nowMs - this.swept >= this.windowMs) {
      for (const [k, w] of this.hits) if (nowMs - w.start >= this.windowMs) this.hits.delete(k);
      this.swept = nowMs;
    }
    let w = this.hits.get(key);
    if (!w || nowMs - w.start >= this.windowMs) {
      w = { start: nowMs, n: 0, refused: false };
      this.hits.set(key, w);
    }
    return w;
  }

  private refuse(w: { start: number; refused: boolean }, nowMs: number): Take {
    const first = !w.refused;
    w.refused = true;
    return {
      ok: false,
      retryAfterS: Math.max(1, Math.ceil((w.start + this.windowMs - nowMs) / 1000)),
      first,
    };
  }

  /** Counts one, or refuses (saying whether it's the window's first refusal, to log it once). */
  take(key: string, nowMs: number): Take {
    const w = this.window(key, nowMs);
    if (w.n >= this.max) return this.refuse(w, nowMs);
    w.n++;
    return { ok: true };
  }

  /** Whether a key has used up its window, without counting anything. */
  check(key: string, nowMs: number): Take {
    const w = this.window(key, nowMs);
    return w.n >= this.max ? this.refuse(w, nowMs) : { ok: true };
  }
}
