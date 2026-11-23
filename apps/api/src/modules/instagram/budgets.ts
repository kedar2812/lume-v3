import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type pg from "pg";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The window a moment falls in (UTC hours and days: a limit is a rate, not a calendar). */
export const hourOf = (now: Date) => new Date(Math.floor(now.getTime() / HOUR) * HOUR);
export const dayOf = (now: Date) => new Date(Math.floor(now.getTime() / DAY) * DAY);

/**
 * One more new lead this hour for this account, if it has room: the count goes up only while under the account's
 * limit, in the caller's transaction. A lead that then isn't made gives its place back (giveBackLead). False: no room.
 */
export async function roomForLead(req: FastifyRequest, accountId: string, now: Date): Promise<boolean> {
  const r = await req.db.execute(sql`
    INSERT INTO instagram_budgets AS b (key, window_start, used)
    SELECT ${`lead:${accountId}`}, ${hourOf(now)}, 1 FROM instagram_accounts a WHERE a.id = ${accountId}
    ON CONFLICT (key, window_start) DO UPDATE SET used = b.used + 1
     WHERE b.used < (SELECT new_leads_per_hour FROM instagram_accounts WHERE id = ${accountId})
    RETURNING b.used`);
  return r.rows.length > 0;
}

/** The place a lead took this hour, given back: the lead wasn't made after all (no pipeline to put it in). */
export async function giveBackLead(req: FastifyRequest, accountId: string, now: Date): Promise<void> {
  await req.db.execute(sql`
    UPDATE instagram_budgets SET used = used - 1
     WHERE key = ${`lead:${accountId}`} AND window_start = ${hourOf(now)} AND used > 0`);
}

/**
 * Whether this is the first time in its window a limit turned something away: true once per window, so the admins
 * hear once an hour (leads) or once a day (files), however many it turns away.
 */
export async function firstRefusal(pool: pg.Pool, key: string, windowStart: Date): Promise<boolean> {
  const r = await pool.query(
    "INSERT INTO instagram_budgets (key, window_start, used) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING RETURNING 1",
    [`told:${key}`, windowStart],
  );
  return (r.rowCount ?? 0) > 0;
}

type Limits = { personBytes: number; accountBytes: number };

/** Whether this person's, or this account's, files today have already reached their limit (nothing fetched then). */
export async function bytesSpent(
  c: pg.PoolClient,
  keys: { person: string; account: string },
  limits: Limits,
  now: Date,
): Promise<boolean> {
  const r = await c.query<{ key: string; used: string }>(
    "SELECT key, used FROM instagram_budgets WHERE window_start = $1 AND key = ANY($2::text[])",
    [dayOf(now), [keys.person, keys.account]],
  );
  const used = new Map(r.rows.map((x) => [x.key, Number(x.used)]));
  return (
    (used.get(keys.person) ?? 0) >= limits.personBytes || (used.get(keys.account) ?? 0) >= limits.accountBytes
  );
}

/**
 * Counts a fetched file against today's limits for the person and the account, both or neither: false (and nothing
 * counted) when it would take either over. Inside the caller's transaction (a savepoint undoes a half-counted file).
 */
export async function spendBytes(
  c: pg.PoolClient,
  keys: { person: string; account: string },
  limits: Limits,
  bytes: number,
  now: Date,
): Promise<boolean> {
  if (bytes > limits.personBytes || bytes > limits.accountBytes) return false;
  await c.query("SAVEPOINT instagram_spend");
  for (const [key, cap] of [
    [keys.person, limits.personBytes],
    [keys.account, limits.accountBytes],
  ] as const) {
    const r = await c.query(
      `INSERT INTO instagram_budgets AS b (key, window_start, used) VALUES ($1, $2, $3)
       ON CONFLICT (key, window_start) DO UPDATE SET used = b.used + EXCLUDED.used
        WHERE b.used + EXCLUDED.used <= $4
       RETURNING b.used`,
      [key, dayOf(now), bytes, cap],
    );
    if (!r.rows.length) {
      await c.query("ROLLBACK TO SAVEPOINT instagram_spend");
      return false;
    }
  }
  await c.query("RELEASE SAVEPOINT instagram_spend");
  return true;
}
