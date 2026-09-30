import { z } from "zod";
import { daysBetween, utcDay } from "@/lib/state";
import type { Ctx } from "./context";

/** Free, no key, has AED and INR (R2): units of each currency per rupee. */
export const FX_URL = "https://open.er-api.com/v6/latest/INR";
const answer = z.object({
  result: z.literal("success"),
  rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.number()),
});

export type RatesNow = {
  /** The day these rates are from, or null when none were ever fetched. */
  day: string | null;
  /** How many days old they are (0: today's). */
  ageDays: number | null;
  /** Rupees for one unit of each currency; INR is always 1. */
  rates: Record<string, number>;
};

/**
 * Today's rates, fetched once a day and stored. If the fetch fails (or answers nonsense), the last good rates
 * stand and the page says how old they are.
 */
export async function refreshRates(
  ctx: Ctx,
): Promise<{ ok: true; day: string } | { ok: false; error: string }> {
  const day = utcDay(ctx.now());
  const have = await ctx.db.query("SELECT 1 FROM fx_rates WHERE day = $1 LIMIT 1", [day]);
  if (have.rowCount) return { ok: true, day };
  try {
    const r = await ctx.fetch(FX_URL, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { ok: false, error: `The rate service answered ${r.status}` };
    const parsed = answer.safeParse(await r.json());
    if (!parsed.success) return { ok: false, error: "The rate service's answer didn't make sense" };
    const rows = Object.entries(parsed.data.rates).filter(
      ([c, perInr]) => c !== "INR" && perInr > 0 && Number.isFinite(perInr),
    );
    if (!rows.length || Object.values(parsed.data.rates).some((v) => !(v > 0)))
      return { ok: false, error: "The rate service's answer didn't make sense" };
    await ctx.db.query(
      `INSERT INTO fx_rates (day, currency, rate_to_inr)
       SELECT $1::date, c, r FROM unnest($2::text[], $3::numeric[]) AS x(c, r)
       ON CONFLICT (day, currency) DO NOTHING`,
      [day, rows.map(([c]) => c), rows.map(([, perInr]) => 1 / perInr)],
    );
    return { ok: true, day };
  } catch (e) {
    return { ok: false, error: `LUME couldn't reach the rate service (${(e as Error).message})` };
  }
}

/** The rates of `day` (default today), or the last day before it that has any. */
export async function currentRates(ctx: Ctx, day = utcDay(ctx.now())): Promise<RatesNow> {
  const { rows } = await ctx.db.query<{ day: string; currency: string; rate: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, currency, rate_to_inr::text AS rate FROM fx_rates
      WHERE day = (SELECT max(day) FROM fx_rates WHERE day <= $1::date)`,
    [day],
  );
  const rates: Record<string, number> = { INR: 1 };
  for (const r of rows) rates[r.currency] = Number(r.rate);
  const at = rows[0]?.day ?? null;
  return { day: at, ageDays: at ? daysBetween(at, utcDay(ctx.now())) : null, rates };
}
