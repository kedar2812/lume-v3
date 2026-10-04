import type pg from "pg";
import { dayOf } from "@lume/core";

/**
 * Keeping analytics' daily rollups (8A, 0053). Each day is recomputed whole by lume_rollup_day, in its own
 * transaction: idempotent, and safe beside another run of the same day (it takes a lock per day).
 *
 * The clock (the follow-up tick) asks for:
 * - every 10 minutes: today and yesterday;
 * - once a night after 02:30 business time: the last 7 days;
 * - once a week (Sunday night): days 8 to 90, since contacts and wins arrive late and move older cohort days.
 */
export async function rollupDays(pool: pg.Pool, days: string[], tz: string): Promise<void> {
  for (const d of days) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT lume_rollup_day($1::date, $2)", [d, tz]);
      await c.query("SELECT lume_rollup_slot_totals($1::date)", [d]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}

/** The business days `from` to `back` days before `now` (0 = today), newest first. */
export function daysBack(now: Date, tz: string, from: number, back: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= back; i++) out.push(dayOf(new Date(now.getTime() - i * 86_400_000), tz));
  return [...new Set(out)];
}

const businessTz = async (pool: pg.Pool) =>
  ((await pool.query<{ timezone: string | null }>("SELECT timezone FROM settings WHERE id = 1")).rows[0]
    ?.timezone ?? "UTC") as string;

/**
 * What the clock should recompute at `now` (called every minute with the tick count `n`). The night and week runs
 * key on the business's own hour, and run once: `lastNight` and `lastWeek` remember the business day they ran.
 */
export async function analyticsTick(
  pool: pg.Pool,
  now: Date,
  n: number,
  memory: { lastNight?: string; lastWeek?: string },
): Promise<void> {
  const tz = await businessTz(pool);
  const today = dayOf(now, tz);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now),
  );
  const minute = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, minute: "2-digit" }).format(now));
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  if (n % 10 === 0) await rollupDays(pool, daysBack(now, tz, 0, 1), tz);
  if ((hour > 2 || (hour === 2 && minute >= 30)) && memory.lastNight !== today) {
    memory.lastNight = today;
    await rollupDays(pool, daysBack(now, tz, 0, 6), tz);
  }
  if (weekday === "Sun" && hour >= 3 && memory.lastWeek !== today) {
    memory.lastWeek = today;
    await rollupDays(pool, daysBack(now, tz, 7, 89), tz);
  }
}
