import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { schema, type SecuritySettings } from "@lume/db";
import { sql } from "drizzle-orm";
import { HttpError, badRequest } from "../../http/errors";
import { audit } from "../../audit/audit";
import type { RateSource } from "../../money/rates";

export type AuthSettings = { timezone: string; security: SecuritySettings };

/** The two settings every request's auth check needs, memoised briefly (settings edits are rare). */
export function memoSettings(pool: pg.Pool, ttlMs = 5000): () => Promise<AuthSettings | null> {
  let at = 0;
  let value: AuthSettings | null = null;
  return async () => {
    if (value && Date.now() - at < ttlMs) return value;
    const { rows } = await pool.query<AuthSettings>("SELECT timezone, security FROM settings WHERE id = 1");
    value = rows[0] ?? null;
    at = Date.now();
    return value;
  };
}

/**
 * LUME uses one currency, the business currency in Settings: every amount is in it. A write that names
 * another currency is refused (rather than stored and mixed into sums); naming the same one is a no-op.
 */
export async function assertOneCurrency(
  req: FastifyRequest,
  currency: string | null | undefined,
): Promise<void> {
  if (!currency) return;
  const [s] = await req.db.select({ currency: schema.settings.currency }).from(schema.settings);
  if (s && currency !== s.currency)
    throw badRequest("ONE_CURRENCY", `LUME uses one currency, ${s.currency}. It can be changed in Settings.`);
}

const currentCurrency = async (req: FastifyRequest, lock = false) => {
  const rows = await req.db.execute<{ currency: string }>(
    lock
      ? sql`SELECT currency FROM settings WHERE id = 1 FOR UPDATE`
      : sql`SELECT currency FROM settings WHERE id = 1`,
  );
  return rows.rows[0]!.currency;
};

/** What switching to `to` would do: the live rate and how many amounts it touches. */
export async function quoteCurrency(req: FastifyRequest, rates: RateSource, to: string) {
  const from = await currentCurrency(req);
  if (to === from) throw badRequest("SAME_CURRENCY", `LUME already uses ${from}`);
  const counts = await req.db.execute<{ leads: number; products: number; fields: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM leads WHERE value IS NOT NULL AND deleted_at IS NULL) AS leads,
      (SELECT count(*)::int FROM products WHERE default_value IS NOT NULL) AS products,
      (SELECT count(*)::int FROM field_definitions WHERE type = 'currency' AND archived_at IS NULL) AS fields
  `);
  let quote;
  try {
    quote = await rates.quote(from, to);
  } catch {
    throw new HttpError(
      502,
      "RATES_UNAVAILABLE",
      "The live rate isn’t available right now. Enter the rate yourself.",
    );
  }
  const c = counts.rows[0]!;
  return { from, to, ...quote, affected: { leads: c.leads, products: c.products, customFields: c.fields } };
}

/**
 * Switch the business currency, converting every amount once at the confirmed rate. `from` must be
 * the currency in use when the admin looked: a second click, or a second admin, gets a 409 instead of
 * converting twice (the settings row is locked for the whole conversion).
 */
export async function switchCurrency(req: FastifyRequest, input: { from: string; to: string; rate: number }) {
  const current = await currentCurrency(req, true);
  if (current !== input.from)
    throw new HttpError(
      409,
      "CURRENCY_CHANGED",
      `The currency was just changed to ${current} by someone else.`,
    );
  if (input.to === current) throw badRequest("SAME_CURRENCY", `LUME already uses ${current}`);
  const keys = await req.db.execute<{ key: string }>(
    sql`SELECT key FROM field_definitions WHERE type = 'currency'`,
  );
  const converted = await req.db.execute<{ leads: number; products: number }>(
    sql`SELECT * FROM convert_amounts(${input.rate}::numeric, ${`{${keys.rows.map((k) => `"${k.key}"`).join(",")}}`}::text[])`,
  );
  await req.db.execute(sql`UPDATE settings SET currency = ${input.to} WHERE id = 1`);
  const counts = {
    leads: Number(converted.rows[0]?.leads ?? 0),
    products: Number(converted.rows[0]?.products ?? 0),
  };
  await audit(req, {
    action: "settings.currency.changed",
    entityType: "settings",
    entityId: "1",
    diff: { from: current, to: input.to, rate: input.rate, converted: counts },
  });
  return { currency: input.to, converted: counts };
}
