import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { schema, type SecuritySettings } from "@lume/db";
import { badRequest } from "../../http/errors";

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
