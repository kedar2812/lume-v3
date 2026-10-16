/**
 * Reports a person has sent in the last window (spec 2026-10-16 §1.4: ten an hour). Only a report that reached LUME's
 * team counts, so a licence server that is down never uses up anyone's allowance. In memory: one API process serves an
 * instance. People whose sends have all left the window are forgotten as it goes.
 */
export class SentLog {
  private readonly sent = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  get size(): number {
    return this.sent.size;
  }

  /** Seconds until this person may send again; 0 now. */
  wait(id: string, nowMs: number): number {
    for (const [k, times] of this.sent) {
      const live = times.filter((t) => nowMs - t < this.windowMs);
      if (live.length) this.sent.set(k, live);
      else this.sent.delete(k);
    }
    const times = this.sent.get(id) ?? [];
    if (times.length < this.max) return 0;
    return Math.max(1, Math.ceil((times[0]! + this.windowMs - nowMs) / 1000));
  }

  record(id: string, nowMs: number): void {
    this.sent.set(id, [...(this.sent.get(id) ?? []), nowMs]);
  }
}
