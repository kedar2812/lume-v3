/**
 * Where exchange rates come from, for the one moment LUME needs one: switching the business currency
 * (every amount is converted once, at a rate the admin confirms). The owner chose open.er-api.com
 * (free, no key, 160+ currencies, updated daily); a keyed hourly feed plugs in the same way.
 */
export type Quote = { rate: number; asOf: string; source: string };
export type RateSource = { quote(from: string, to: string): Promise<Quote> };

const TIMEOUT_MS = 5000;

export function openErApi(fetchImpl: typeof fetch = fetch): RateSource {
  return {
    async quote(from, to) {
      const res = await fetchImpl(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      const body = (await res.json().catch(() => null)) as {
        result?: string;
        time_last_update_utc?: string;
        rates?: Record<string, number>;
      } | null;
      const rate = body?.result === "success" ? body.rates?.[to] : undefined;
      if (typeof rate !== "number" || !(rate > 0)) throw new Error(`no rate for ${from} to ${to}`);
      const asOf = body?.time_last_update_utc ? new Date(body.time_last_update_utc) : new Date();
      return { rate, asOf: asOf.toISOString(), source: "open.er-api.com" };
    },
  };
}

export function openExchangeRates(key: string, fetchImpl: typeof fetch = fetch): RateSource {
  return {
    async quote(from, to) {
      const res = await fetchImpl(
        `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(key)}`,
        {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      const body = (await res.json().catch(() => null)) as {
        timestamp?: number;
        rates?: Record<string, number>;
      } | null;
      const a = body?.rates?.[from];
      const b = body?.rates?.[to];
      if (!a || !b) throw new Error(`no rate for ${from} to ${to}`);
      return {
        rate: b / a,
        asOf: new Date((body?.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
        source: "openexchangerates.org",
      };
    },
  };
}

/**
 * Rates from a fixed table, "AED:USD=0.27,USD:EUR=0.92" (tests and the e2e stack; never the internet).
 * The reverse of each pair is answered too.
 */
export function fixedRates(table: string): RateSource {
  const rates = new Map<string, number>();
  for (const pair of table
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [key, value] = pair.split("=");
    const n = Number(value);
    if (!key || !(n > 0)) continue;
    const [from, to] = key.split(":");
    rates.set(`${from}:${to}`, n);
    rates.set(`${to}:${from}`, 1 / n);
  }
  return {
    async quote(from, to) {
      const rate = rates.get(`${from}:${to}`);
      if (!rate) throw new Error(`no rate for ${from} to ${to}`);
      return { rate, asOf: "2026-09-25T00:00:00.000Z", source: "fixed" };
    },
  };
}
