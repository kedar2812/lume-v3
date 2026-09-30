/** At start and every hour: today's exchange rates (once a day, R2) and check-ins past 180 days (R3). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { context } = await import("./server/context");
  const { refreshRates } = await import("./server/fx");
  const { pruneCheckIns } = await import("./server/check");
  const tick = async () => {
    try {
      const ctx = context();
      const r = await refreshRates(ctx);
      if (!r.ok) console.warn(`exchange rates: ${r.error} (the last rates stand)`);
      await pruneCheckIns(ctx.db, ctx.now());
    } catch (e) {
      console.error("hourly upkeep failed", e);
    }
  };
  void tick();
  setInterval(() => void tick(), 3_600_000).unref();
}
