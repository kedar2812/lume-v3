import type { PlanClaim } from "@lume/core";
import type pg from "pg";
import { HttpError } from "../../http/errors";
import { readAs } from "../notifications/hub";
import { adminIds, notify } from "../notifications/notify";

/**
 * The monthly limit on paid WhatsApp messages (W3b-2 Task 5; owner 2026-10-19: usage is monthly, generous, and at the
 * limit nothing more goes until an admin asks for more). WhatsApp bills the business for templates; this keeps a
 * surprise bill from happening.
 */

/** The lower of the plan's limit and the admin's own; null when neither sets one. */
export function paidLimit(
  plan: PlanClaim | null | undefined,
  settings: { paidSendsMonthly: number | null },
): number | null {
  const limits = [plan?.paidSendsMonthly ?? null, settings.paidSendsMonthly].filter(
    (n): n is number => n !== null,
  );
  return limits.length ? Math.min(...limits) : null;
}

/** This calendar month on the business's clock: [its first moment, the next month's]. */
export async function monthOf(q: Pick<pg.Pool, "query">, now: Date, tz: string): Promise<[Date, Date]> {
  const { rows } = await q.query<{ from_at: Date; to_at: Date }>(
    `SELECT date_trunc('month', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2 AS from_at,
            (date_trunc('month', $1::timestamptz AT TIME ZONE $2) + interval '1 month') AT TIME ZONE $2 AS to_at`,
    [now, tz],
  );
  return [rows[0]!.from_at, rows[0]!.to_at];
}

/** Paid messages this month, every lead's (not failed ones): counted by the database, whoever asks. */
export async function paidUse(q: Pick<pg.Pool, "query">, now: Date, tz: string): Promise<number> {
  const [from, to] = await monthOf(q, now, tz);
  const { rows } = await q.query<{ n: number }>("SELECT lume_whatsapp_paid_count($1, $2) AS n", [from, to]);
  return rows[0]!.n;
}

const n = (x: number) => x.toLocaleString("en");

export const paidLimitError = (used: number, limit: number) =>
  new HttpError(
    409,
    "PAID_LIMIT",
    `This month's paid WhatsApp messages are used up (${n(used)} of ${n(limit)}). An admin can ask for more.`,
  );

/** At 80% of the month's limit, the admins hear it once that month. */
export async function notePaidUse(pool: pg.Pool, now: Date, tz: string, used: number, limit: number) {
  if (used < Math.ceil(limit * 0.8)) return;
  const [from] = await monthOf(pool, now, tz);
  const month = from.toISOString();
  const title = `80% of this month's paid WhatsApp messages are used (${n(used)} of ${n(limit)}).`;
  const body = `At ${n(limit)}, LUME stops sending them until next month, or until an admin asks for more.`;
  for (const userId of await adminIds(pool)) {
    // Notices are their recipient's own (row-level security): looked at as them. Once a month: the month it's for is
    // kept with it.
    const sent = await readAs(pool, userId, (c) =>
      c.query(
        "SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'whatsapp_usage' AND data->>'month' = $2 LIMIT 1",
        [userId, month],
      ),
    );
    if (!sent.rows.length)
      await notify(pool, userId, { kind: "whatsapp_usage", title, body, data: { month } });
  }
}
