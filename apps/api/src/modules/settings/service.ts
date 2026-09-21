import type pg from "pg";
import type { SecuritySettings } from "@lume/db";

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
