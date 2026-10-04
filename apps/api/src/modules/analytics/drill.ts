import { sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { scopeOf, type Keyring, type MetricId, type Range } from "@lume/core";
import type { AppDeps } from "../../app";
import { HttpError, notFound } from "../../http/errors";
import { liveFilter, ownerCond, sourceCond } from "./filters";
import type { AnalyticsQuery } from "./service";

/**
 * Drill-downs (8A, spec §5.2; 8D spec §4): every number opens the leads behind it. A number carries a token — what
 * kind of number it is (a tile's metric, a source row, a lost reason, a heatmap cell…), anything that picks its row
 * out (a source, a stage, a person…), the exact span and filters, the person it was made for and a 15-minute expiry —
 * sealed with the keyring (so it can't be read or altered). Opening it recomputes the leads by the number's own
 * definition, then lists them through the Leads list, so row-level security and masking apply exactly as on the
 * Leads screen.
 *
 * The definitions live here once, as SQL fragments over the alias `l` (leads): the drill-downs use them, and so do
 * the live counts a tag or field filter needs (live.ts), so a filtered number and its list can't disagree.
 */
export type DrillKind =
  | MetricId
  | "funnel_reached"
  | "funnel_stopped"
  | "stage_now"
  | "stuck"
  | "source_leads"
  | "source_won"
  | "lost_reason"
  | "lost_stage"
  | "lost_cell"
  | "won_back"
  | "segment"
  | "product_won"
  | "slot"
  | "meeting_outcome"
  | "person_cohort"
  | "person_won"
  | "unowned"
  | "phone_needs_country"
  | "phone_invalid";

export type SlotKind = "arrivals" | "sends" | "replies" | "booked" | "held" | "no_show";
export type DrillExtra = {
  stageId?: string | null;
  sourceId?: string | null;
  reasonId?: string | null;
  productId?: string | null;
  userId?: string | null;
  field?: { key: string; value: string };
  slot?: { kind: SlotKind; dow: number; hour: number };
  outcome?: "completed" | "no_show" | "cancelled" | "rescheduled" | "scheduled";
  wait?: "under_1h" | "under_1d" | "under_7d" | "over_7d";
};

export type DrillSpec = {
  k: DrillKind;
  x?: DrillExtra;
  /** Business days, first and last. */
  d: [string, string];
  /** The span as instants (from inclusive, to exclusive). */
  t: [string, string];
  /** The business's timezone, for numbers keyed by weekday and hour. */
  z?: string;
  q: Pick<AnalyticsQuery, "pipelineId" | "ownerIds" | "sourceIds" | "tagIds" | "fields">;
  u: string;
  exp: number;
};
type Scoped = DrillSpec & { q: DrillSpec["q"] & { reach?: string | null } };

const CONTEXT = "analytics-drill";
export const DRILL_TTL_MS = 15 * 60_000;
export const DRILL_MAX = 10_000;

export function mintDrill(keyring: Keyring, spec: Omit<DrillSpec, "exp">, now: Date): string {
  return keyring
    .encrypt(JSON.stringify({ ...spec, exp: now.getTime() + DRILL_TTL_MS }), CONTEXT)
    .toString("base64url");
}

/** A token for one number of a module: the range and filters it was computed with, for the person asking. */
export function drillFor(
  d: Pick<AppDeps, "keyring">,
  req: FastifyRequest,
  range: Range,
  q: AnalyticsQuery,
  tz: string,
  k: DrillKind,
  x: DrillExtra | undefined,
  now: Date,
): string {
  return mintDrill(
    d.keyring,
    {
      k,
      ...(x ? { x } : {}),
      d: [range.days[0]!, range.days.at(-1)!],
      t: [range.from.toISOString(), range.to.toISOString()],
      z: tz,
      q: {
        ...(q.pipelineId ? { pipelineId: q.pipelineId } : {}),
        ...(q.ownerIds?.length ? { ownerIds: q.ownerIds } : {}),
        ...(q.sourceIds?.length ? { sourceIds: q.sourceIds } : {}),
        ...(q.tagIds?.length ? { tagIds: q.tagIds } : {}),
        ...(q.fields ? { fields: q.fields } : {}),
      },
      u: req.actor!.userId,
    },
    now,
  );
}

export function readDrill(keyring: Keyring, token: string, userId: string, now: Date): DrillSpec {
  let spec: DrillSpec & { m?: MetricId };
  try {
    spec = JSON.parse(keyring.decrypt(Buffer.from(token, "base64url"), CONTEXT)) as DrillSpec & {
      m?: MetricId;
    };
  } catch {
    throw notFound("DRILL_NOT_FOUND", "That list isn't available.");
  }
  // Made for someone else: as if it didn't exist.
  if (spec.u !== userId) throw notFound("DRILL_NOT_FOUND", "That list isn't available.");
  if (spec.exp < now.getTime())
    throw new HttpError(410, "DRILL_EXPIRED", "This list has expired. Open the number again to see it.");
  // A token made before 8D named its metric `m`.
  return spec.k ? spec : { ...spec, k: spec.m! };
}

const credit = (col: SQL, q: Scoped["q"]): SQL => {
  if (q.reach === "all" && !q.ownerIds?.length) return sql`true`;
  const parts: SQL[] = [sql`lume_sees_credit(${col})`];
  const own = ownerCond(q.ownerIds, col);
  if (own) parts.push(own);
  return sql.join(parts, sql` AND `);
};
const COHORT_OWNER = sql`coalesce(lume_owner_at(l.id, l.created_at, l.owner_id),
  (SELECT h.to_user_id FROM lead_assignment_history h WHERE h.lead_id = l.id AND h.to_user_id IS NOT NULL
   ORDER BY h.changed_at, h.id LIMIT 1))`;
const eqOrNull = (col: SQL, v: string | null | undefined) =>
  v ? sql`${col} = ${v}::uuid` : sql`${col} IS NULL`;

/** The shared definitions, over leads `l` (and meetings `m`, tasks `t` inside their own EXISTS). */
export const frag = {
  credit,
  COHORT_OWNER,
  span(s: Scoped, col: SQL): SQL {
    return sql`${col} >= ${s.t[0]}::timestamptz AND ${col} < ${s.t[1]}::timestamptz`;
  },
  /** Leads that arrived in the span, credited to their owner at arrival (or their first owner). */
  cohort(s: Scoped): SQL {
    return sql`(l.lead_created_at BETWEEN ${s.d[0]}::date AND ${s.d[1]}::date
      OR (l.lead_created_at IS NULL AND ${frag.span(s, sql`l.created_at`)})) AND ${credit(COHORT_OWNER, s.q)}`;
  },
  /** Leads won in the span, credited to whoever owned them when won. */
  won(s: Scoped): SQL {
    return sql`${frag.span(s, sql`l.won_at`)} AND ${credit(sql`lume_owner_at(l.id, l.won_at, l.owner_id)`, s.q)}`;
  },
  /** Leads lost in the span, credited to whoever owned them when lost. */
  lost(s: Scoped): SQL {
    return sql`${frag.span(s, sql`l.lost_at`)} AND ${credit(sql`lume_owner_at(l.id, l.lost_at, l.owner_id)`, s.q)}`;
  },
  meeting(s: Scoped, cond: SQL): SQL {
    return sql`EXISTS (SELECT 1 FROM meetings m WHERE m.lead_id = l.id AND ${cond} AND ${credit(sql`m.owner_id`, s.q)})`;
  },
  /** The lead filters every number shares: not deleted, and the pipeline and source asked for. */
  leads(s: Scoped): SQL {
    const parts: SQL[] = [sql`l.deleted_at IS NULL`];
    if (s.q.pipelineId) parts.push(sql`l.pipeline_id = ${s.q.pipelineId}::uuid`);
    const src = sourceCond(s.q.sourceIds, sql`l.source_id`);
    if (src) parts.push(src);
    // A number counted under a tag or field filter opens only the leads that carry it.
    const live = liveFilter(s.q);
    if (live) parts.push(live);
    return sql.join(parts, sql` AND `);
  },
  /** A custom field's value as it's stored: yes/no fields hold JSON booleans. */
  fieldValue(v: string): string | boolean {
    return v === "true" ? true : v === "false" ? false : v;
  },
  /** One cell of a timing heatmap: what happened in that weekday and hour, in the business's time. */
  slot(s: Scoped): SQL {
    const x = s.x!.slot!;
    const tz = s.z ?? "UTC";
    const at = (col: SQL) =>
      sql`extract(dow FROM ${col} AT TIME ZONE ${tz}) = ${x.dow} AND extract(hour FROM ${col} AT TIME ZONE ${tz}) = ${x.hour}`;
    const send = (extra: SQL) => sql`EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id
      AND a.type = 'whatsapp_confirmed_sent' AND ${frag.span(s, sql`a.occurred_at`)} AND ${at(sql`a.occurred_at`)}
      AND ${credit(sql`a.user_id`, s.q)} ${extra})`;
    switch (x.kind) {
      case "arrivals":
        return sql`${frag.span(s, sql`l.created_at`)} AND ${at(sql`l.created_at`)}
          AND ${credit(sql`lume_owner_at(l.id, l.created_at, l.owner_id)`, s.q)}`;
      case "sends":
        return send(sql``);
      case "replies":
        return send(sql`AND EXISTS (SELECT 1 FROM activities r WHERE r.lead_id = a.lead_id AND r.type = 'reply_logged'
          AND r.occurred_at > a.occurred_at AND r.occurred_at <= a.occurred_at + interval '72 hours')`);
      case "booked":
        return frag.meeting(
          s,
          sql`${frag.span(s, sql`m.starts_at`)} AND ${at(sql`m.starts_at`)} AND m.status IN ('scheduled', 'completed', 'no_show')`,
        );
      case "held":
        return frag.meeting(
          s,
          sql`${frag.span(s, sql`m.starts_at`)} AND ${at(sql`m.starts_at`)} AND m.status = 'completed'`,
        );
      case "no_show":
        return frag.meeting(
          s,
          sql`${frag.span(s, sql`m.starts_at`)} AND ${at(sql`m.starts_at`)} AND m.status = 'no_show'`,
        );
    }
  },
  /** Unowned leads by how long they've waited (only with the 'all' reach: no one else sees unowned leads). */
  unowned(wait: NonNullable<DrillExtra["wait"]>): SQL {
    const age = {
      under_1h: sql`l.created_at > now() - interval '1 hour'`,
      under_1d: sql`l.created_at <= now() - interval '1 hour' AND l.created_at > now() - interval '1 day'`,
      under_7d: sql`l.created_at <= now() - interval '1 day' AND l.created_at > now() - interval '7 days'`,
      over_7d: sql`l.created_at <= now() - interval '7 days'`,
    }[wait];
    return sql`l.owner_id IS NULL AND ${age} AND lume_analytics_scope() = 'all'`;
  },
  /** The Overview tiles' definitions (8A), unchanged. */
  metric(s: Scoped): SQL | null {
    const cohort = frag.cohort(s);
    const firsts = sql`EXISTS (SELECT 1 FROM lead_firsts f WHERE f.lead_id = l.id AND f.first_contact_at IS NOT NULL`;
    const won = frag.won(s);
    const span = (col: SQL) => frag.span(s, col);
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
      lost: frag.lost(s),
      calls_booked: frag.meeting(s, sql`${span(sql`m.created_at`)} AND m.status <> 'rescheduled'`),
      calls_held: frag.meeting(s, sql`${span(sql`m.starts_at`)} AND m.status = 'completed'`),
      no_show_rate: frag.meeting(s, sql`${span(sql`m.starts_at`)} AND m.status = 'no_show'`),
      overdue_now: sql`EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.status = 'open' AND t.due_at < now()
        AND ${credit(sql`t.assignee_id`, s.q)})`,
      // The late ones: due in the span, done after their time (five minutes' grace).
      ontime: sql`EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND ${span(sql`t.due_at`)} AND t.status = 'done'
        AND t.done_at > t.due_at + interval '5 minutes' AND ${credit(sql`t.assignee_id`, s.q)})`,
      forecast: sql`l.value IS NOT NULL AND EXISTS (SELECT 1 FROM stages st WHERE st.id = l.stage_id AND st.kind = 'open')
        AND ${credit(sql`l.owner_id`, s.q)}`,
    };
    by.lateness = by.ontime!;
    return by[s.k as MetricId] ?? null;
  },
};

/** The leads behind one number, as SQL over `l`; null for a kind with no list. */
export function kindWhere(s: Scoped): SQL | null {
  const x = s.x ?? {};
  switch (s.k) {
    case "source_leads":
      return sql`${frag.cohort(s)} AND ${eqOrNull(sql`l.source_id`, x.sourceId)}`;
    case "source_won":
      return sql`${frag.won(s)} AND ${eqOrNull(sql`l.source_id`, x.sourceId)}`;
    case "lost_reason":
      return sql`${frag.lost(s)} AND ${eqOrNull(sql`l.lost_reason_id`, x.reasonId)}`;
    case "lost_cell":
      return sql`${frag.lost(s)} AND ${eqOrNull(sql`l.lost_reason_id`, x.reasonId)} AND ${eqOrNull(sql`l.source_id`, x.sourceId)}`;
    case "lost_stage":
      return sql`${frag.lost(s)} AND ${eqOrNull(
        sql`(SELECT h.from_stage_id FROM lead_stage_history h WHERE h.lead_id = l.id AND h.changed_at <= l.lost_at
             ORDER BY h.changed_at DESC, h.id DESC LIMIT 1)`,
        x.stageId,
      )}`;
    case "won_back":
      return sql`${frag.won(s)} AND EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.type = 'reopened'
        AND a.occurred_at >= ${s.t[0]}::timestamptz AND a.occurred_at < l.won_at)`;
    case "product_won":
      return sql`${frag.won(s)} AND ${eqOrNull(sql`l.product_id`, x.productId)}`;
    case "person_cohort":
      return sql`${frag.cohort(s)} AND ${eqOrNull(COHORT_OWNER, x.userId)}`;
    case "person_won":
      return sql`${frag.won(s)} AND ${eqOrNull(sql`lume_owner_at(l.id, l.won_at, l.owner_id)`, x.userId)}`;
    case "stage_now":
      return x.stageId ? sql`l.stage_id = ${x.stageId}::uuid AND ${credit(sql`l.owner_id`, s.q)}` : null;
    case "stuck":
      return x.stageId
        ? sql`l.stage_id = ${x.stageId}::uuid AND EXISTS (SELECT 1 FROM stages st WHERE st.id = l.stage_id
            AND st.sla_hours IS NOT NULL AND l.stage_entered_at < now() - make_interval(hours => st.sla_hours))
            AND ${credit(sql`l.owner_id`, s.q)}`
        : null;
    case "slot":
      return x.slot ? frag.slot(s) : null;
    case "meeting_outcome":
      return x.outcome
        ? frag.meeting(s, sql`${frag.span(s, sql`m.starts_at`)} AND m.status = ${x.outcome}`)
        : null;
    case "segment":
      return x.field
        ? sql`${frag.cohort(s)} AND l.custom @> ${JSON.stringify({ [x.field.key]: frag.fieldValue(x.field.value) })}::jsonb`
        : null;
    case "unowned":
      return x.wait ? frag.unowned(x.wait) : null;
    case "phone_needs_country":
      return sql`l.phone_status = 'needs_country' AND ${credit(sql`l.owner_id`, s.q)}`;
    case "phone_invalid":
      return sql`l.phone_status = 'invalid' AND ${credit(sql`l.owner_id`, s.q)}`;
    case "funnel_reached":
      // Cohort leads whose furthest stage (0056, the rollups' rule) is this one or later; won is the furthest of all.
      return x.stageId
        ? sql`${frag.cohort(s)} AND EXISTS (SELECT 1 FROM stages fs, stages target
            WHERE fs.id = lume_furthest_stage(l.id, l.pipeline_id) AND target.id = ${x.stageId}::uuid
              AND (fs.kind = 'won' OR (target.kind = 'open' AND fs.position >= target.position)))`
        : null;
    case "funnel_stopped":
      return x.stageId
        ? sql`${frag.cohort(s)} AND lume_furthest_stage(l.id, l.pipeline_id) = ${x.stageId}::uuid`
        : null;
    default:
      return frag.metric(s);
  }
}

/** The leads behind a number, by its own definition (the rollups use the same ones). */
export async function drillIds(req: FastifyRequest, spec: DrillSpec): Promise<string[]> {
  // Read afresh: the reach now, not when the token was made.
  const s: Scoped = { ...spec, q: { ...spec.q, reach: scopeOf(req.actor!, "analytics.view") } };
  const where = kindWhere(s);
  if (!where) throw notFound("DRILL_NOT_FOUND", "That number has no list.");
  const r = await req.db.execute<{ id: string }>(sql`
    SELECT l.id FROM leads l WHERE ${frag.leads(s)} AND ${where} LIMIT ${DRILL_MAX}`);
  return r.rows.map((x) => x.id);
}
