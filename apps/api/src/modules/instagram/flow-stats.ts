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

/** The business's days a range names (its time zone, at most a year), and the moments they start and end. */
async function statsRange(
  req: FastifyRequest,
  ask: { from?: string; to?: string; days?: number },
  now: Date,
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
  return { q, start, end, zone };
}

/** What started a conversation a flow answered (the Flows board's chart): a flow started by another isn't a new one. */
export const FLOW_STARTS = ["comment", "dm", "ad", "story"] as const;
type FlowStart = (typeof FLOW_STARTS)[number];

type FlowRow = {
  id: string;
  triggered: number;
  finished: number;
  leads: number;
  handed: number;
  booked: number;
  won: number;
  revenue: string;
};
type Board = {
  flows: FlowRow[];
  total: {
    triggered: number;
    finished: number;
    leads: number;
    handed: number;
    booked: number;
    won: number;
    booked_new: number;
    won_new: number;
    revenue: string;
    first_s: number | null;
    team_s: number | null;
    ran_out: number;
    stopped: number;
  };
  series: { day: string; start: FlowStart; n: number }[];
  sources: { kind: string; id: string; conversations: number; leads: number }[];
  byFlow: { flowId: string; kind: string; id: string; conversations: number; leads: number }[];
};

/**
 * Every flow's numbers over one range, in one answer (plan 2026-11-25-instagram-screens D3; the Flows board, D6b-2):
 * what each flow did, and across them: conversations started by what started them (a flow another started isn't a new
 * conversation), how many finished, became leads, booked and won (money only for someone who sees it), the first
 * answer's median (the run's start to the flow's first send), those passed to the team and how long the team took,
 * those passed on whom nobody answered within Instagram's 24 hours, those who asked to stop, the posts and ads that
 * started them, and what LUME noticed. Counts for the whole business, read from each flow's slice of the
 * (flow, kind, at) index, in one statement.
 */
export async function flowsSummary(
  req: FastifyRequest,
  ask: { from?: string; to?: string; days?: number },
  now: Date = new Date(),
  money = false,
) {
  const { q, start, end, zone } = await statsRange(req, ask, now);
  const r = await withAllScope(req, () =>
    req.db.execute<{ j: Board }>(sql`
      WITH runs AS MATERIALIZED (
        SELECT r.id, r.flow_id, r.thread_id, r.lead_id, r.status, r.reason, r.started_by, e.at
          FROM instagram_flows f
          CROSS JOIN LATERAL (
            SELECT e.run_id, e.at FROM instagram_flow_events e
             WHERE e.flow_id = f.id AND e.kind = 'triggered' AND e.at >= ${start} AND e.at < ${end}) e
          JOIN instagram_flow_runs r ON r.id = e.run_id
         WHERE f.status <> 'archived'),
      ev AS MATERIALIZED (
        SELECT e.run_id, e.kind, min(e.at) AS at
          FROM (SELECT DISTINCT flow_id FROM runs) fl
          CROSS JOIN LATERAL (
            SELECT run_id, kind, at FROM instagram_flow_events e
             WHERE e.flow_id = fl.flow_id AND e.kind IN ('dm_sent', 'private_reply', 'lead_created', 'handed')
               AND e.at >= ${start} AND e.at < (${end}) + interval '30 days') e
         WHERE e.run_id IN (SELECT id FROM runs)
         GROUP BY 1, 2),
      x AS MATERIALIZED (
        SELECT r.*,
               (SELECT min(v.at) FROM ev v WHERE v.run_id = r.id AND v.kind IN ('dm_sent', 'private_reply')) AS sent_at,
               EXISTS (SELECT 1 FROM ev v WHERE v.run_id = r.id AND v.kind = 'lead_created') AS lead,
               h.at AS handed_at, tm.at AS team_at,
               r.status = 'done' AND r.reason IS NULL AS done,
               l.id IS NOT NULL AND EXISTS (SELECT 1 FROM meetings m WHERE m.lead_id = l.id AND m.created_at >= r.at
                         AND m.status <> 'cancelled') AS booked,
               l.won_at IS NOT NULL AND l.won_at >= r.at AS won, l.value,
               coalesce(l.dnc_reason = 'Said stop on Instagram' AND l.dnc_at >= r.at, false) AS stopped,
               t.source ->> 'adId' AS ad_id,
               -- Instagram's window for an answer: 7 days after an ad click started it, else 24 hours.
               CASE WHEN r.started_by = 'ad' THEN interval '7 days' ELSE interval '24 hours' END AS win,
               CASE r.started_by WHEN 'comment' THEN 'comment' WHEN 'ad' THEN 'ad'
                    WHEN 'story_reply' THEN 'story' WHEN 'story_mention' THEN 'story'
                    WHEN 'goto' THEN NULL ELSE 'dm' END AS start
          FROM runs r
          LEFT JOIN leads l ON l.id = r.lead_id AND l.deleted_at IS NULL
          LEFT JOIN instagram_threads t ON t.id = r.thread_id
          LEFT JOIN ev h ON h.run_id = r.id AND h.kind = 'handed'
          LEFT JOIN LATERAL (
            SELECT min(a.occurred_at) AS at FROM activities a
             WHERE a.lead_id = r.lead_id AND a.occurred_at >= h.at AND a.payload ->> 'threadId' = r.thread_id::text
               AND (a.type = 'instagram_sent'
                    OR (a.type = 'instagram_confirmed_sent' AND a.payload ->> 'via' IS DISTINCT FROM 'flow'))
          ) tm ON h.at IS NOT NULL),
      -- The conversations the flows answered: a run another flow started is the same conversation, counted once.
      c AS (SELECT * FROM x WHERE start IS NOT NULL),
      src AS (
        SELECT x.flow_id, x.lead, s.kind, s.id FROM c x
         CROSS JOIN LATERAL (
           SELECT CASE WHEN x.ad_id IS NOT NULL THEN 'ad' ELSE lower(coalesce(k.media_type, 'post')) END AS kind,
                  coalesce(x.ad_id, k.media_id) AS id
             FROM (SELECT 1) one
             LEFT JOIN LATERAL (
               SELECT media_id, media_type FROM instagram_comments
                WHERE thread_id = x.thread_id AND media_id IS NOT NULL ORDER BY at LIMIT 1) k ON x.ad_id IS NULL) s
         WHERE s.id IS NOT NULL)
      SELECT json_build_object(
        'flows', (SELECT coalesce(json_agg(row_to_json(f)), '[]'::json) FROM (
          SELECT fl.id, count(x.id)::int AS triggered, count(x.id) FILTER (WHERE x.done)::int AS finished,
                 count(x.id) FILTER (WHERE x.lead)::int AS leads,
                 count(x.id) FILTER (WHERE x.handed_at IS NOT NULL)::int AS handed,
                 count(DISTINCT x.lead_id) FILTER (WHERE x.booked)::int AS booked,
                 count(DISTINCT x.lead_id) FILTER (WHERE x.won)::int AS won,
                 (SELECT coalesce(sum(w.value), 0) FROM (SELECT DISTINCT ON (y.lead_id) y.value FROM x y
                   WHERE y.flow_id = fl.id AND y.won) w)::text AS revenue
            FROM instagram_flows fl LEFT JOIN x ON x.flow_id = fl.id
           WHERE fl.status <> 'archived'
           GROUP BY fl.id, fl.priority, fl.created_at
           ORDER BY fl.priority DESC, fl.created_at) f),
        'total', (SELECT row_to_json(t) FROM (
          SELECT count(*)::int AS triggered,
                 count(*) FILTER (WHERE done)::int AS finished, count(*) FILTER (WHERE lead)::int AS leads,
                 count(*) FILTER (WHERE handed_at IS NOT NULL)::int AS handed,
                 count(DISTINCT lead_id) FILTER (WHERE booked)::int AS booked,
                 count(DISTINCT lead_id) FILTER (WHERE won)::int AS won,
                 count(DISTINCT lead_id) FILTER (WHERE booked AND lead)::int AS booked_new,
                 count(DISTINCT lead_id) FILTER (WHERE won AND lead)::int AS won_new,
                 (SELECT coalesce(sum(w.value), 0) FROM (SELECT DISTINCT ON (lead_id) value FROM c WHERE won) w)::text
                   AS revenue,
                 (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM sent_at - at))
                    FILTER (WHERE sent_at IS NOT NULL))::float8 AS first_s,
                 (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM team_at - handed_at))
                    FILTER (WHERE team_at IS NOT NULL))::float8 AS team_s,
                 count(*) FILTER (WHERE handed_at IS NOT NULL AND handed_at + win <= ${now}::timestamptz
                   AND (team_at IS NULL OR team_at > handed_at + win))::int AS ran_out,
                 count(DISTINCT lead_id) FILTER (WHERE stopped)::int AS stopped
            FROM c) t),
        'series', (SELECT coalesce(json_agg(row_to_json(d)), '[]'::json) FROM (
          SELECT to_char((at AT TIME ZONE ${zone})::date, 'YYYY-MM-DD') AS day, start, count(*)::int AS n
            FROM c GROUP BY 1, 2) d),
        'sources', (SELECT coalesce(json_agg(row_to_json(s)), '[]'::json) FROM (
          SELECT kind, id, count(*)::int AS conversations, count(*) FILTER (WHERE lead)::int AS leads
            FROM src GROUP BY kind, id ORDER BY count(*) FILTER (WHERE lead) DESC, count(*) DESC, id LIMIT 10) s),
        'byFlow', (SELECT coalesce(json_agg(row_to_json(s)), '[]'::json) FROM (
          SELECT "flowId", kind, id, conversations, leads FROM (
            SELECT flow_id AS "flowId", kind, id, count(*)::int AS conversations,
                   count(*) FILTER (WHERE lead)::int AS leads,
                   row_number() OVER (PARTITION BY flow_id
                                      ORDER BY count(*) FILTER (WHERE lead) DESC, count(*) DESC, id) AS n
              FROM src GROUP BY flow_id, kind, id) ranked
           WHERE n <= 5) s)) AS j`),
  );
  const b = r.rows[0]!.j;
  const t = b.total;
  // The business's days, each with zeros where nothing started.
  const days: string[] = [];
  for (let d = Date.parse(q.from); d <= Date.parse(q.to); d += 86_400_000)
    days.push(new Date(d).toISOString().slice(0, 10));
  const per = new Map(b.series.map((x) => [`${x.day}|${x.start}`, x.n]));
  const total = {
    triggered: t.triggered,
    finished: t.finished,
    leads: t.leads,
    handed: t.handed,
    booked: t.booked,
    won: t.won,
    bookedNew: t.booked_new,
    wonNew: t.won_new,
    revenue: money ? Number(t.revenue) : null,
    firstAnswerSec: t.first_s === null ? null : Math.round(t.first_s),
    teamAnswerSec: t.team_s === null ? null : Math.round(t.team_s),
    ranOut: t.ran_out,
    stopped: t.stopped,
  };
  const flows = b.flows.map((f) => ({ ...f, revenue: money ? Number(f.revenue) : null }));
  return {
    from: q.from,
    to: q.to,
    total,
    flows,
    series: days.map((day) => ({
      day,
      ...Object.fromEntries(FLOW_STARTS.map((k) => [k, per.get(`${day}|${k}`) ?? 0])),
    })) as ({ day: string } & Record<FlowStart, number>)[],
    sources: b.sources,
    sourcesByFlow: b.byFlow,
    notes: flowNotes(total, flows, b.sources),
  };
}

const TOO_FEW = 10;
const SOURCE_WORD: Record<string, string> = {
  ad: "An ad",
  reels: "A reel",
  reel: "A reel",
  video: "A video",
};

/**
 * LUME noticed on the Flows page: at most three things the numbers show, each with its counts, none from too few.
 */
export function flowNotes(
  t: { ranOut: number; handed: number },
  flows: { id: string; triggered: number; finished: number }[],
  sources: { kind: string; conversations: number; leads: number }[],
): { id: string; title: string; body: string; flowId?: string }[] {
  const notes: { id: string; title: string; body: string; flowId?: string }[] = [];
  if (t.ranOut > 0)
    notes.push({
      id: "ran_out",
      title: `${t.ranOut.toLocaleString("en-US")} passed to your team waited too long`,
      body: `A flow asked for a person and nobody answered within Instagram's window (24 hours, 7 days after an ad click). ${t.handed.toLocaleString("en-US")} were passed on in all.`,
    });
  const best = sources
    .filter((x) => x.conversations >= TOO_FEW)
    .sort((a, b) => b.leads / b.conversations - a.leads / a.conversations || b.leads - a.leads)[0];
  if (best && best.leads > 0)
    notes.push({
      id: "best_source",
      title: `${SOURCE_WORD[best.kind] ?? "A post"} brings the most leads`,
      body: `${best.leads.toLocaleString("en-US")} leads from ${best.conversations.toLocaleString("en-US")} people its flows answered: ${Math.round((best.leads * 100) / best.conversations)} in every 100.`,
    });
  const enough = flows
    .filter((f) => f.triggered >= TOO_FEW)
    .sort((a, b) => a.finished / a.triggered - b.finished / b.triggered);
  const lowest = enough[0];
  const highest = enough.at(-1);
  // One flow alone, or every flow alike: nothing to say about which loses the most.
  if (lowest && highest && lowest.finished / lowest.triggered < highest.finished / highest.triggered)
    notes.push({
      id: "finish",
      flowId: lowest.id,
      title: "One flow loses the most people",
      body: `${Math.round((lowest.finished * 100) / lowest.triggered)} in every 100 who start it get to its end. Pick it above to see the step where they stop.`,
    });
  return notes;
}

export async function flowStats(
  req: FastifyRequest,
  flowId: string,
  ask: { from?: string; to?: string; days?: number },
  now: Date = new Date(),
) {
  const { q, start, end } = await statsRange(req, ask, now);
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
