import { sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { quantileFromHist, trend } from "@lume/core";
import type { AppDeps } from "../../app";
import { drillFor, type DrillExtra, type DrillKind } from "./drill";
import { ownerCond, sourceCond } from "./filters";
import { TOO_FEW, businessTz, rangeOf, reachOf, seesRevenue, type AnalyticsQuery } from "./service";

/**
 * The other analytics modules (8A, spec §4): sources and revenue, lost, timing (heatmaps, time in stage, stuck),
 * templates and data quality. Rollups where they carry the answer; live reads, bounded by the span and the viewer's
 * reach, where each lead is needed (lost reasons, templates, data quality).
 */
const rate = (a: number, b: number) => (b > 0 ? a / b : null);
const AVG_MONTH_DAYS = 30.4375;

/** Drill tokens for a module's numbers when a screen asks (routes pass `d`); none for the insights or the email. */
type Mint = (k: DrillKind, x?: DrillExtra) => string | undefined;
function minter(
  d: Pick<AppDeps, "keyring"> | undefined,
  req: FastifyRequest,
  range: Parameters<typeof drillFor>[2],
  q: AnalyticsQuery,
  tz: string,
  now: Date,
): Mint {
  return d ? (k, x) => drillFor(d, req, range, q, tz, k, x, now) : () => undefined;
}

function rw(q: AnalyticsQuery, from: string, to: string, pipelineNullable = false): SQL {
  const parts: SQL[] = [sql`day BETWEEN ${from}::date AND ${to}::date`];
  if (q.pipelineId)
    parts.push(
      pipelineNullable
        ? sql`(pipeline_id = ${q.pipelineId}::uuid)`
        : sql`pipeline_id = ${q.pipelineId}::uuid`,
    );
  const src = sourceCond(q.sourceIds, sql`source_id`);
  if (src) parts.push(src);
  const own = ownerCond(q.ownerIds, sql`user_id`);
  if (own) parts.push(own);
  return sql.join(parts, sql` AND `);
}
function credit(q: AnalyticsQuery, col: SQL): SQL {
  if (q.reach === "all" && !q.ownerIds?.length) return sql`true`;
  const parts: SQL[] = [sql`lume_sees_credit(${col})`];
  const own = ownerCond(q.ownerIds, col);
  if (own) parts.push(own);
  return sql.join(parts, sql` AND `);
}
function leadWhere(q: AnalyticsQuery): SQL {
  const parts: SQL[] = [sql`l.deleted_at IS NULL`];
  if (q.pipelineId) parts.push(sql`l.pipeline_id = ${q.pipelineId}::uuid`);
  const src = sourceCond(q.sourceIds, sql`l.source_id`);
  if (src) parts.push(src);
  return sql.join(parts, sql` AND `);
}

/** Revenue and sources (canvas Revenue): per source, leads, how many are won, the money, and what it cost. */
export async function sources(
  req: FastifyRequest,
  q: AnalyticsQuery,
  now: Date,
  d?: Pick<AppDeps, "keyring">,
) {
  q = { ...q, reach: reachOf(req, q.ownerIds) };
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  const mint = minter(d, req, range, q, tz, now);
  const [from, to] = [range.days[0]!, range.days.at(-1)!];
  const money = seesRevenue(req);
  const [cohort, events, srcs, series] = await Promise.all([
    req.db.execute<{ source_id: string | null; arrived: number; won: number }>(sql`
      SELECT source_id, sum(arrived)::int AS arrived, sum(won)::int AS won FROM analytics_daily_cohort
      WHERE ${rw(q, from, to)} GROUP BY source_id`),
    req.db.execute<{ source_id: string | null; won: number; value: number }>(sql`
      SELECT source_id, sum(won)::int AS won, sum(won_value)::float8 AS value FROM analytics_daily_event
      WHERE ${rw(q, from, to, true)} GROUP BY source_id`),
    req.db.execute<{ id: string; name: string; type: string; spend: string | null }>(sql`
      SELECT id, name, type, monthly_spend::text AS spend FROM lead_sources`),
    req.db.execute<{ day: string; value: number }>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(won_value)::float8 AS value FROM analytics_daily_event
      WHERE ${rw(q, from, to, true)} GROUP BY day`),
  ]);
  const name = new Map(srcs.rows.map((s) => [s.id, s]));
  const ids = new Set([...cohort.rows.map((r) => r.source_id), ...events.rows.map((r) => r.source_id)]);
  const totalLeads = cohort.rows.reduce((a, r) => a + r.arrived, 0);
  const totalValue = events.rows.reduce((a, r) => a + r.value, 0);
  const share = range.days.length / AVG_MONTH_DAYS;
  const rows = [...ids].map((id) => {
    const c = cohort.rows.find((r) => r.source_id === id);
    const e = events.rows.find((r) => r.source_id === id);
    const s = id ? name.get(id) : undefined;
    const spend = s?.spend !== null && s?.spend !== undefined ? Number(s.spend) * share : null;
    const leads = c?.arrived ?? 0;
    return {
      id,
      name: s?.name ?? (id ? "A removed source" : "Added in LUME"),
      kind: s?.type ?? "manual",
      drill: { leads: mint("source_leads", { sourceId: id }), won: mint("source_won", { sourceId: id }) },
      leads,
      leadShare: rate(leads, totalLeads),
      winRate: rate(c?.won ?? 0, leads),
      tooFew: leads < TOO_FEW,
      won: e?.won ?? 0,
      ...(money
        ? {
            revenue: e?.value ?? 0,
            revenueShare: rate(e?.value ?? 0, totalValue),
            spend,
            costPerLead: spend !== null && leads ? spend / leads : null,
            returnPerSpent: spend ? (e?.value ?? 0) / spend : null,
          }
        : {}),
    };
  });
  rows.sort((a, b) => b.leads - a.leads);
  const byDay = new Map(series.rows.map((r) => [r.day, r.value]));
  return {
    range: { label: range.label, days: range.days },
    sources: rows,
    ...(money ? { revenueByDay: range.days.map((d) => byDay.get(d) ?? 0) } : {}),
  };
}

/** Lost (canvas Lost): why, from which stage, by whom and from where; and leads won back. */
export async function lost(req: FastifyRequest, q: AnalyticsQuery, now: Date, d?: Pick<AppDeps, "keyring">) {
  q = { ...q, reach: reachOf(req, q.ownerIds) };
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  const mint = minter(d, req, range, q, tz, now);
  const span = (from: Date, to: Date) =>
    sql`l.lost_at >= ${from.toISOString()}::timestamptz AND l.lost_at < ${to.toISOString()}::timestamptz`;
  const who = sql`lume_owner_at(l.id, l.lost_at, l.owner_id)`;
  const base = (from: Date, to: Date) => sql`${leadWhere(q)} AND ${span(from, to)} AND ${credit(q, who)}`;
  const [reasons, prevReasons, stages, owners, srcs, back] = await Promise.all([
    req.db.execute<{ id: string | null; name: string | null; n: number }>(sql`
      SELECT l.lost_reason_id AS id, r.label::text AS name, count(*)::int AS n FROM leads l
      LEFT JOIN lost_reasons r ON r.id = l.lost_reason_id
      WHERE ${base(range.from, range.to)} GROUP BY 1, 2 ORDER BY n DESC`),
    req.db.execute<{ id: string | null; n: number }>(sql`
      SELECT l.lost_reason_id AS id, count(*)::int AS n FROM leads l
      WHERE ${base(range.previous.from, range.previous.to)} GROUP BY 1`),
    // The stage a lead left when it was lost: the last stage change into its lost stage.
    req.db.execute<{ id: string | null; name: string | null; n: number }>(sql`
      SELECT h.from_stage_id AS id, s.name, count(*)::int AS n FROM leads l
      CROSS JOIN LATERAL (SELECT h.from_stage_id FROM lead_stage_history h WHERE h.lead_id = l.id AND h.changed_at <= l.lost_at
                          ORDER BY h.changed_at DESC, h.id DESC LIMIT 1) h
      LEFT JOIN stages s ON s.id = h.from_stage_id
      WHERE ${base(range.from, range.to)} GROUP BY 1, 2 ORDER BY n DESC`),
    // By who owned them when they were lost: the event rollups already credit that.
    req.db.execute<{ id: string | null; n: number }>(sql`
      SELECT user_id AS id, sum(lost)::int AS n FROM analytics_daily_event
      WHERE ${rw(q, range.days[0]!, range.days.at(-1)!, true)} GROUP BY 1 HAVING sum(lost) > 0 ORDER BY n DESC`),
    req.db.execute<{ id: string | null; n: number }>(sql`
      SELECT l.source_id AS id, count(*)::int AS n FROM leads l WHERE ${base(range.from, range.to)} GROUP BY 1 ORDER BY n DESC`),
    // Won back: reopened in the span after being lost, and won in the span.
    req.db.execute<{ n: number; value: number }>(sql`
      SELECT count(*)::int AS n, coalesce(sum(l.value), 0)::float8 AS value FROM leads l
      WHERE ${leadWhere(q)} AND l.won_at >= ${range.from.toISOString()}::timestamptz AND l.won_at < ${range.to.toISOString()}::timestamptz
        AND ${credit(q, sql`lume_owner_at(l.id, l.won_at, l.owner_id)`)}
        AND EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.type = 'reopened'
                    AND a.occurred_at >= ${range.from.toISOString()}::timestamptz AND a.occurred_at < l.won_at)`),
  ]);
  const total = reasons.rows.reduce((a, r) => a + r.n, 0);
  const prevTotal = prevReasons.rows.reduce((a, r) => a + r.n, 0);
  const money = seesRevenue(req);
  return {
    range: { label: range.label, days: range.days },
    total,
    previousTotal: q.compare ? prevTotal : null,
    reasons: reasons.rows.map((r) => {
      const share = rate(r.n, total);
      const before = rate(prevReasons.rows.find((p) => p.id === r.id)?.n ?? 0, prevTotal);
      return {
        id: r.id,
        name: r.name ?? "No reason given",
        drill: mint("lost_reason", { reasonId: r.id }),
        n: r.n,
        before: prevReasons.rows.find((p) => p.id === r.id)?.n ?? 0,
        share,
        trend:
          q.compare && share !== null && before !== null
            ? trend(share, before, { kind: "pts", good: "down" })
            : null,
      };
    }),
    stages: stages.rows.map((s) => ({
      id: s.id,
      name: s.name ?? "Before any stage",
      n: s.n,
      drill: mint("lost_stage", { stageId: s.id }),
    })),
    owners: owners.rows,
    sources: srcs.rows,
    wonBack: {
      n: back.rows[0]!.n,
      ...(money ? { value: back.rows[0]!.value } : {}),
      drill: mint("won_back"),
    },
  };
}

/** Timing (canvas Timing): when leads arrive and reply, the best booking slots, time in each stage, and stuck leads. */
export async function timing(req: FastifyRequest, q: AnalyticsQuery, now: Date) {
  q = { ...q, reach: reachOf(req, q.ownerIds) };
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  const [from, to] = [range.days[0]!, range.days.at(-1)!];
  const slotWhere = (() => {
    const parts: SQL[] = [sql`day BETWEEN ${from}::date AND ${to}::date`];
    const own = ownerCond(q.ownerIds, sql`user_id`);
    if (own) parts.push(own);
    return sql.join(parts, sql` AND `);
  })();
  const [slots, stays, stuck] = await Promise.all([
    // Everyone's, with no one picked: the totals per hour (0055), a fraction of the rows.
    req.db.execute<{ kind: string; dow: number; hour: number; n: number }>(sql`
      SELECT kind, dow, hour, sum(n)::int AS n
      FROM ${q.reach === "all" && !q.ownerIds?.length ? sql`analytics_daily_slot_total` : sql`analytics_daily_slot`}
      WHERE ${slotWhere} GROUP BY 1, 2, 3`),
    req.db.execute<{ stage_id: string; name: string; exited: number; h: number[] }>(sql`
      SELECT a.stage_id, s.name, sum(a.exited)::int AS exited,
             ARRAY[${sql.raw(Array.from({ length: 12 }, (_, i) => `coalesce(sum(a.stay_hist[${i + 1}]), 0)::int`).join(", "))}] AS h
      FROM analytics_daily_stage a JOIN stages s ON s.id = a.stage_id
      WHERE a.day BETWEEN ${from}::date AND ${to}::date
        ${q.pipelineId ? sql`AND a.pipeline_id = ${q.pipelineId}::uuid` : sql``}
        AND ${ownerCond(q.ownerIds, sql`a.user_id`) ?? sql`true`}
      GROUP BY a.stage_id, s.name, s.position ORDER BY s.position`),
    req.db.execute<{ stage_id: string; n: number }>(sql`
      SELECT l.stage_id, count(*)::int AS n FROM leads l JOIN stages s ON s.id = l.stage_id
      WHERE ${leadWhere(q)} AND s.kind = 'open' AND s.sla_hours IS NOT NULL
        AND l.stage_entered_at < now() - make_interval(hours => s.sla_hours) AND ${credit(q, sql`l.owner_id`)}
      GROUP BY l.stage_id`),
  ]);
  const grid = (kind: string) => {
    const g = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const r of slots.rows) if (r.kind === kind) g[r.dow]![r.hour] = r.n;
    return g;
  };
  const ratio = (num: number[][], den: number[][], min: number) =>
    den.map((row, d) =>
      row.map((n, h) => (n >= min ? { rate: num[d]![h]! / n, n } : { rate: null, n, tooFew: true })),
    );
  return {
    range: { label: range.label, days: range.days },
    // 0 = Sunday … 6 = Saturday; hours 0–23, in the business's time.
    arrivals: grid("arrivals"),
    replies: ratio(grid("replies"), grid("sends"), 10),
    booking: ratio(grid("held"), grid("booked"), 5),
    stages: stays.rows.map((s) => ({
      id: s.stage_id,
      name: s.name,
      exited: s.exited,
      medianMinutes: quantileFromHist(s.h, 0.5),
      p75Minutes: quantileFromHist(s.h, 0.75),
      tooFew: s.exited < TOO_FEW,
      stuckNow: stuck.rows.find((x) => x.stage_id === s.stage_id)?.n ?? 0,
    })),
  };
}

/** Templates (canvas Templates): per template, sends, replies within 72 hours, and wins within 30 days. */
export async function templates(req: FastifyRequest, q: AnalyticsQuery, now: Date) {
  q = { ...q, reach: reachOf(req, q.ownerIds) };
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  const r = await req.db.execute<{
    id: string;
    name: string;
    sends: number;
    replies: number;
    wins: number;
  }>(sql`
    SELECT t.id, t.name::text AS name, count(*)::int AS sends,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM activities r WHERE r.lead_id = a.lead_id AND r.type = 'reply_logged'
             AND r.occurred_at > a.occurred_at AND r.occurred_at <= a.occurred_at + interval '72 hours'))::int AS replies,
           count(*) FILTER (WHERE l.won_at > a.occurred_at AND l.won_at <= a.occurred_at + interval '30 days'
             AND NOT EXISTS (SELECT 1 FROM activities n WHERE n.lead_id = a.lead_id AND n.type = 'whatsapp_confirmed_sent'
                             AND n.occurred_at > a.occurred_at AND n.occurred_at < l.won_at))::int AS wins
    FROM activities a
    JOIN leads l ON l.id = a.lead_id
    JOIN template_versions v ON v.id = (a.payload->>'templateVersionId')::uuid
    JOIN message_templates t ON t.id = v.template_id
    WHERE a.type = 'whatsapp_confirmed_sent' AND a.payload ? 'templateVersionId'
      AND a.occurred_at >= ${range.from.toISOString()}::timestamptz AND a.occurred_at < ${range.to.toISOString()}::timestamptz
      AND ${leadWhere(q)} AND ${credit(q, sql`a.user_id`)}
    GROUP BY t.id, t.name ORDER BY sends DESC`);
  return {
    range: { label: range.label, days: range.days },
    templates: r.rows.map((t) => ({ ...t, replyRate: rate(t.replies, t.sends), tooFew: t.sends < TOO_FEW })),
  };
}

/** Data quality (canvas Quality): numbers that need a country or are invalid, unowned leads by how long they've waited, rejected import rows. */
export async function quality(req: FastifyRequest, q: AnalyticsQuery, now: Date) {
  q = { ...q, reach: reachOf(req, q.ownerIds) };
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  const [phones, unowned, imports] = await Promise.all([
    req.db.execute<{ status: string; n: number }>(sql`
      SELECT l.phone_status AS status, count(*)::int AS n FROM leads l
      WHERE ${leadWhere(q)} AND l.phone_status IN ('needs_country', 'invalid') AND ${credit(q, sql`l.owner_id`)}
      GROUP BY 1`),
    req.db.execute<{ bucket: string; n: number }>(sql`
      SELECT CASE WHEN l.created_at > now() - interval '1 hour' THEN 'under_1h'
                  WHEN l.created_at > now() - interval '1 day' THEN 'under_1d'
                  ELSE 'over_1d' END AS bucket, count(*)::int AS n
      FROM leads l WHERE ${leadWhere(q)} AND l.owner_id IS NULL AND lume_analytics_scope() = 'all' GROUP BY 1`),
    req.db.execute<{ source_id: string; name: string; errors: number; skipped: number }>(sql`
      SELECT i.source_id, s.name, sum(i.errors)::int AS errors, sum(i.skipped)::int AS skipped
      FROM imports i JOIN lead_sources s ON s.id = i.source_id
      WHERE i.finished_at >= ${range.from.toISOString()}::timestamptz AND i.finished_at < ${range.to.toISOString()}::timestamptz
        AND lume_analytics_scope() = 'all'
      GROUP BY 1, 2`),
  ]);
  return {
    range: { label: range.label, days: range.days },
    phoneNeedsCountry: phones.rows.find((r) => r.status === "needs_country")?.n ?? 0,
    phoneInvalid: phones.rows.find((r) => r.status === "invalid")?.n ?? 0,
    unowned: {
      under1h: unowned.rows.find((r) => r.bucket === "under_1h")?.n ?? 0,
      under1d: unowned.rows.find((r) => r.bucket === "under_1d")?.n ?? 0,
      over1d: unowned.rows.find((r) => r.bucket === "over_1d")?.n ?? 0,
    },
    importsRejected: imports.rows,
  };
}
