import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { badRequest } from "../../http/errors";
import { drillFor, frag } from "./drill";
import { LIVE_MAX_DAYS } from "./filters";
import { spanOf } from "./live";
import { businessTz, rangeOf, reachOf, type AnalyticsQuery } from "./service";

/**
 * What converts (canvas Lost; 8A spec §4 `segment`): of the leads that arrived in the range, the share won so far,
 * by each answer to a choice, multiple-choice or yes/no field. Custom fields live on each lead, so this always reads
 * the leads, bounded to 92 days. A lead with several answers counts in each.
 */
const MIN_GROUP = 10;
const KINDS = ["select", "multi_select", "boolean"] as const;
type Field = { key: string; label: string; type: (typeof KINDS)[number]; options: unknown };

export async function segments(
  req: FastifyRequest,
  q: AnalyticsQuery,
  key: string | undefined,
  now: Date,
  d?: Pick<AppDeps, "keyring">,
) {
  q = { ...q, reach: reachOf(req, q.ownerIds) };
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  if (range.days.length > LIVE_MAX_DAYS)
    throw badRequest(
      "RANGE_TOO_LONG_FOR_FILTER",
      "Narrow the range to 92 days or less to see what converts.",
    );
  const fields = (
    await req.db.execute<Field>(sql`
      SELECT key, label, type, options FROM field_definitions
      WHERE archived_at IS NULL AND type IN ('select', 'multi_select', 'boolean') ORDER BY position, label`)
  ).rows;
  const fieldList = fields.map((f) => ({ key: f.key, label: f.label, type: f.type }));
  if (!key)
    return { range: { label: range.label, days: range.days }, field: null, groups: [], fields: fieldList };
  const field = fields.find((f) => f.key === key);
  if (!field) throw badRequest("BAD_FIELD", "Choose a choice, multiple-choice or yes/no field.");

  const s = spanOf(q, range);
  const value =
    field.type === "multi_select"
      ? sql`v.value`
      : field.type === "boolean"
        ? sql`(l.custom -> ${key})::text`
        : sql`l.custom ->> ${key}`;
  const from =
    field.type === "multi_select"
      ? sql`leads l LEFT JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(l.custom -> ${key}) = 'array' THEN l.custom -> ${key} ELSE '[]'::jsonb END) v(value) ON true`
      : sql`leads l`;
  const r = await req.db.execute<{ v: string | null; arrived: number; won: number }>(sql`
    SELECT ${value} AS v, count(*)::int AS arrived, count(*) FILTER (WHERE l.won_at IS NOT NULL)::int AS won
    FROM ${from} WHERE ${frag.leads(s)} AND ${frag.cohort(s)} GROUP BY 1`);

  const options =
    field.type === "boolean"
      ? ["true", "false"]
      : Array.isArray(field.options)
        ? (field.options as unknown[]).map((o) =>
            typeof o === "string"
              ? o
              : String((o as { label?: string; value?: string }).value ?? (o as { label?: string }).label),
          )
        : [];
  const label = (v: string | null) =>
    v === null ? "Not answered" : field.type === "boolean" ? (v === "true" ? "Yes" : "No") : v;
  // The field's own order first, then any answer no longer offered, then the unanswered.
  const known = r.rows.map((x) => x.v);
  const order = [
    ...options.filter((o) => known.includes(o)),
    ...known.filter((v) => v !== null && !options.includes(v)),
    ...(known.includes(null) ? [null] : []),
  ];
  return {
    range: { label: range.label, days: range.days },
    field: { key: field.key, label: field.label, type: field.type },
    groups: order.map((v) => {
      const row = r.rows.find((x) => x.v === v)!;
      return {
        value: v,
        label: label(v),
        arrived: row.arrived,
        won: row.won,
        rate: row.arrived ? row.won / row.arrived : null,
        tooFew: row.arrived < MIN_GROUP,
        drill:
          v !== null && d
            ? drillFor(d, req, range, q, tz, "segment", { field: { key, value: v } }, now)
            : undefined,
      };
    }),
    fields: fieldList,
  };
}
