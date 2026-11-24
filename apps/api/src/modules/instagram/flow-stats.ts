import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { badRequest } from "../../http/errors";
import { withAllScope } from "./service";

/**
 * What a flow brought (NEW_FEATURES_PLAN §4.7; plan 1B Task 6), over a range of the business's days: conversations it
 * started, private replies and DMs sent, people who answered, leads it made, calls booked and leads won after it, in
 * total and by keyword. Counts for the whole business (no lead data), straight from the indexed event rows: one
 * flow's events over a range read only that flow's slice of the index, so it stays quick at any volume.
 */
export const STATS_MAX_DAYS = 366;

type Row = {
  keyword: string | null;
  triggered: number;
  private_replies: number;
  dms: number;
  replied: number;
  leads: number;
  handed: number;
  booked: number;
  won: number;
};

/** The business's own calendar day for a moment (yyyy-mm-dd in its time zone). */
export const dayIn = (zone: string, at: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

export async function flowStats(
  req: FastifyRequest,
  flowId: string,
  ask: { from?: string; to?: string; days?: number },
  now: Date = new Date(),
) {
  const zone =
    (await req.db.execute<{ tz: string | null }>(sql`SELECT timezone AS tz FROM settings WHERE id = 1`))
      .rows[0]?.tz ?? "UTC";
  // "The last N days" are the business's days, ending today where the business is (review 2026-11-24: never the
  // viewer's browser's days).
  let q: { from: string; to: string };
  if (ask.from && ask.to && !ask.days) q = { from: ask.from, to: ask.to };
  else if (ask.days && !ask.from && !ask.to) {
    const to = dayIn(zone, now);
    const from = new Date(Date.parse(to) - (ask.days - 1) * 86_400_000).toISOString().slice(0, 10);
    q = { from, to };
  } else throw badRequest("RANGE", "Choose the days: a start and an end, or how many days back.");
  const real = (d: string) =>
    !Number.isNaN(Date.parse(d)) && new Date(Date.parse(d)).toISOString().slice(0, 10) === d;
  if (!real(q.from) || !real(q.to)) throw badRequest("RANGE", "Choose real days.");
  if (q.to < q.from) throw badRequest("RANGE", "The range ends before it starts.");
  const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 + 1;
  if (days > STATS_MAX_DAYS) throw badRequest("RANGE", "Choose at most a year.");
  // The business's days: from midnight of `from` to the end of `to`, in its own time zone.
  const start = sql`(${q.from}::date)::timestamp AT TIME ZONE ${zone}`;
  const end = sql`((${q.to}::date + 1))::timestamp AT TIME ZONE ${zone}`;
  const r = await withAllScope(req, () =>
    req.db.execute<Row>(sql`
      WITH ev AS (
        SELECT keyword, kind, run_id, lead_id, at FROM instagram_flow_events
         WHERE flow_id = ${flowId} AND at >= ${start} AND at < ${end} AND kind <> 'entered'),
      runs AS (
        SELECT DISTINCT ON (run_id) run_id, keyword, lead_id, at FROM ev WHERE kind = 'triggered' ORDER BY run_id, at),
      after AS (
        SELECT r.keyword,
               EXISTS (SELECT 1 FROM meetings m WHERE m.lead_id = r.lead_id AND m.created_at >= r.at
                         AND m.status <> 'cancelled') AS booked,
               EXISTS (SELECT 1 FROM lead_stage_history h JOIN stages s ON s.id = h.to_stage_id
                        WHERE h.lead_id = r.lead_id AND h.changed_at >= r.at AND s.kind = 'won') AS won
          FROM runs r)
      SELECT e.keyword,
             count(*) FILTER (WHERE e.kind = 'triggered')::int AS triggered,
             count(*) FILTER (WHERE e.kind = 'private_reply')::int AS private_replies,
             count(*) FILTER (WHERE e.kind = 'dm_sent')::int AS dms,
             count(*) FILTER (WHERE e.kind = 'replied')::int AS replied,
             count(*) FILTER (WHERE e.kind = 'lead_created')::int AS leads,
             count(*) FILTER (WHERE e.kind = 'handed')::int AS handed,
             (SELECT count(*) FILTER (WHERE a.booked) FROM after a WHERE a.keyword IS NOT DISTINCT FROM e.keyword)::int AS booked,
             (SELECT count(*) FILTER (WHERE a.won) FROM after a WHERE a.keyword IS NOT DISTINCT FROM e.keyword)::int AS won
        FROM ev e
       GROUP BY e.keyword
       ORDER BY count(*) FILTER (WHERE e.kind = 'triggered') DESC, e.keyword`),
  );
  // The numbers on each step and line (the builder's Numbers): how many runs entered each step, how many people, what
  // it sent; and how many runs went down each line (one step to the next, in the order a run entered them).
  const steps = await withAllScope(req, () =>
    req.db.execute<{ j: { steps: Record<string, StepCount>; lines: Record<string, number> } }>(sql`
      WITH ev AS (
        SELECT id, run_id, lead_id, kind, split_part(step_key, ':', 1) AS step FROM instagram_flow_events
         WHERE flow_id = ${flowId} AND at >= ${start} AND at < ${end}
           AND kind IN ('entered', 'dm_sent', 'private_reply') AND step_key IS NOT NULL),
      per AS (
        SELECT step,
               count(*) FILTER (WHERE kind = 'entered')::int AS entered,
               count(DISTINCT lead_id) FILTER (WHERE kind = 'entered')::int AS people,
               count(*) FILTER (WHERE kind <> 'entered')::int AS sent
          FROM ev GROUP BY step),
      seq AS (
        SELECT step, lag(step) OVER (PARTITION BY run_id ORDER BY id) AS prev FROM ev WHERE kind = 'entered'),
      lines AS (SELECT prev || '>' || step AS line, count(*)::int AS n FROM seq WHERE prev IS NOT NULL GROUP BY 1)
      SELECT json_build_object(
               'steps', (SELECT coalesce(json_object_agg(step, json_build_object('entered', entered, 'people', people,
                                                                                 'sent', sent)), '{}') FROM per),
               'lines', (SELECT coalesce(json_object_agg(line, n), '{}') FROM lines)) AS j`),
  );
  const sum = (k: keyof Omit<Row, "keyword">) => r.rows.reduce((n, x) => n + x[k], 0);
  const total = {
    triggered: sum("triggered"),
    privateReplies: sum("private_replies"),
    dms: sum("dms"),
    replied: sum("replied"),
    leads: sum("leads"),
    handed: sum("handed"),
    booked: sum("booked"),
    won: sum("won"),
  };
  return {
    from: q.from,
    to: q.to,
    total,
    byKeyword: r.rows.map((x) => ({
      keyword: x.keyword,
      triggered: x.triggered,
      privateReplies: x.private_replies,
      dms: x.dms,
      replied: x.replied,
      leads: x.leads,
      handed: x.handed,
      booked: x.booked,
      won: x.won,
    })),
    byStep: steps.rows[0]!.j.steps,
    /** Keyed "from>to" by step id. */
    byLine: steps.rows[0]!.j.lines,
  };
}

type StepCount = { entered: number; people: number; sent: number };
