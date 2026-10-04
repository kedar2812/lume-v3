import { sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Keyring, MetricId } from "@lume/core";
import { HttpError, notFound } from "../../http/errors";
import type { AnalyticsQuery } from "./service";

/**
 * Drill-downs (8A, spec §5.2): every number opens the leads behind it. A tile carries a token — the metric, the
 * exact span and filters, the person it was made for and a 15-minute expiry — sealed with the keyring (so it can't be
 * read or altered). Opening it recomputes the leads by the metric's definition, then lists them through the Leads
 * list, so row-level security and masking apply exactly as on the Leads screen.
 */
export type DrillSpec = {
  m: MetricId;
  /** Business days, first and last. */
  d: [string, string];
  /** The span as instants (from inclusive, to exclusive). */
  t: [string, string];
  q: Pick<AnalyticsQuery, "pipelineId" | "ownerId" | "sourceId">;
  u: string;
  exp: number;
};

const CONTEXT = "analytics-drill";
export const DRILL_TTL_MS = 15 * 60_000;
export const DRILL_MAX = 10_000;

export function mintDrill(keyring: Keyring, spec: Omit<DrillSpec, "exp">, now: Date): string {
  return keyring
    .encrypt(JSON.stringify({ ...spec, exp: now.getTime() + DRILL_TTL_MS }), CONTEXT)
    .toString("base64url");
}

export function readDrill(keyring: Keyring, token: string, userId: string, now: Date): DrillSpec {
  let spec: DrillSpec;
  try {
    spec = JSON.parse(keyring.decrypt(Buffer.from(token, "base64url"), CONTEXT)) as DrillSpec;
  } catch {
    throw notFound("DRILL_NOT_FOUND", "That list isn't available.");
  }
  // Made for someone else: as if it didn't exist.
  if (spec.u !== userId) throw notFound("DRILL_NOT_FOUND", "That list isn't available.");
  if (spec.exp < now.getTime())
    throw new HttpError(410, "DRILL_EXPIRED", "This list has expired. Open the number again to see it.");
  return spec;
}

const credit = (col: SQL, q: DrillSpec["q"]): SQL => {
  const parts: SQL[] = [sql`lume_sees_credit(${col})`];
  if (q.ownerId) parts.push(q.ownerId === "none" ? sql`${col} IS NULL` : sql`${col} = ${q.ownerId}::uuid`);
  return sql.join(parts, sql` AND `);
};
const COHORT_OWNER = sql`coalesce(lume_owner_at(l.id, l.created_at, l.owner_id),
  (SELECT h.to_user_id FROM lead_assignment_history h WHERE h.lead_id = l.id AND h.to_user_id IS NOT NULL
   ORDER BY h.changed_at, h.id LIMIT 1))`;

/** The leads behind a number, by the metric's own definition (the rollups use the same ones). */
export async function drillIds(req: FastifyRequest, s: DrillSpec): Promise<string[]> {
  const [d0, d1] = s.d;
  const [t0, t1] = s.t;
  const lead: SQL[] = [sql`l.deleted_at IS NULL`];
  if (s.q.pipelineId) lead.push(sql`l.pipeline_id = ${s.q.pipelineId}::uuid`);
  if (s.q.sourceId) lead.push(sql`l.source_id = ${s.q.sourceId}::uuid`);
  const span = (col: SQL) => sql`${col} >= ${t0}::timestamptz AND ${col} < ${t1}::timestamptz`;
  const cohort = sql`(l.lead_created_at BETWEEN ${d0}::date AND ${d1}::date
    OR (l.lead_created_at IS NULL AND ${span(sql`l.created_at`)})) AND ${credit(COHORT_OWNER, s.q)}`;
  const firsts = sql`EXISTS (SELECT 1 FROM lead_firsts f WHERE f.lead_id = l.id AND f.first_contact_at IS NOT NULL`;
  const won = sql`${span(sql`l.won_at`)} AND ${credit(sql`lume_owner_at(l.id, l.won_at, l.owner_id)`, s.q)}`;
  const meeting = (cond: SQL) =>
    sql`EXISTS (SELECT 1 FROM meetings m WHERE m.lead_id = l.id AND ${cond} AND ${credit(sql`m.owner_id`, s.q)})`;
  const by: Partial<Record<MetricId, SQL>> = {
    new_leads: cohort,
    contacted: sql`${cohort} AND ${firsts})`,
    reply_rate: sql`${cohort} AND ${firsts} AND f.first_reply_at IS NOT NULL)`,
    speed_to_lead: sql`${cohort} AND ${firsts})`,
    win_rate: sql`${cohort} AND l.won_at IS NOT NULL`,
    won,
    revenue_won: won,
    avg_deal: sql`${won} AND l.value IS NOT NULL`,
    cycle: won,
    lost: sql`${span(sql`l.lost_at`)} AND ${credit(sql`lume_owner_at(l.id, l.lost_at, l.owner_id)`, s.q)}`,
    calls_booked: meeting(sql`${span(sql`m.created_at`)} AND m.status <> 'rescheduled'`),
    calls_held: meeting(sql`${span(sql`m.starts_at`)} AND m.status = 'completed'`),
    no_show_rate: meeting(sql`${span(sql`m.starts_at`)} AND m.status = 'no_show'`),
    overdue_now: sql`EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.status = 'open' AND t.due_at < now()
      AND ${credit(sql`t.assignee_id`, s.q)})`,
    // The late ones: due in the span, done after their time (five minutes' grace).
    ontime: sql`EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND ${span(sql`t.due_at`)} AND t.status = 'done'
      AND t.done_at > t.due_at + interval '5 minutes' AND ${credit(sql`t.assignee_id`, s.q)})`,
    forecast: sql`l.value IS NOT NULL AND EXISTS (SELECT 1 FROM stages st WHERE st.id = l.stage_id AND st.kind = 'open')
      AND ${credit(sql`l.owner_id`, s.q)}`,
  };
  by.lateness = by.ontime!;
  const where = by[s.m];
  if (!where) throw notFound("DRILL_NOT_FOUND", "That number has no list.");
  const r = await req.db.execute<{ id: string }>(sql`
    SELECT l.id FROM leads l WHERE ${sql.join(lead, sql` AND `)} AND ${where} LIMIT ${DRILL_MAX}`);
  return r.rows.map((x) => x.id);
}
