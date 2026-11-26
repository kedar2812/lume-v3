import { sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { liveFilter, ownerCond, sourceCond } from "./filters";
import { guardLive } from "./live";
import { assertLeadAccess, businessTz, narrow, rangeOf, seesRevenue, type AnalyticsQuery } from "./service";

/**
 * Instagram in Analytics (plan 2026-11-25-instagram-screens D6b, board Analytics). A conversation is an Instagram
 * thread started in the range; what started it is the thread's source as it started (a comment, an ad click, a story,
 * else a first DM; an ad click on an older conversation doesn't change what started it). A new lead is one made from
 * the conversation (not one it was matched to); leads, calls and wins count each lead once. Its timings read the lead's own messages on that thread: their first message, and the first answer after it
 * (a flow's, or a person's from LUME or the Instagram app), in time when inside Meta's window for it (24 hours; 7 days
 * when an ad click started it). Someone who sees only their own (or their team's) leads sees the conversations on
 * those; a conversation not yet a lead counts only for someone who sees everything, with no lead filter on. Every part
 * is read from the leads and conversations the viewer can open, so someone whose analytics reach is wider than the
 * leads they can open is refused in words, never shown part of the numbers as the whole.
 */
export const IG_STARTS = ["comment", "dm", "ad", "story"] as const;
export type IgStart = (typeof IG_STARTS)[number];

const WINDOW_S = 24 * 3600;
const AD_WINDOW_S = 7 * 24 * 3600;

type Totals = {
  conversations: number;
  /** New leads: made from the conversation, each once. */
  leads: number;
  /** Wrote, and the window for an answer is over or answered: what "in time" is out of. */
  measured: number;
  inTime: number;
  ranOut: number;
  firstAnswerSec: number | null;
  /** Each lead once, whether made from the conversation or matched to it. */
  booked: number;
  won: number;
  /** Of the new leads: the funnel's last steps. */
  bookedNew: number;
  wonNew: number;
  revenue: number | null;
  adClicks: number;
  privateReplies: number;
  stopped: number;
  byStart: Record<IgStart, number>;
};

/** Who may be counted: the viewer's reach and the filters, through the lead (none of them: every visible thread). */
function leadCond(q: AnalyticsQuery): SQL {
  const parts: SQL[] = [];
  if (q.pipelineId) parts.push(sql`l.pipeline_id = ${q.pipelineId}::uuid`);
  const own = ownerCond(q.ownerIds, sql`l.owner_id`);
  if (own) parts.push(own);
  const src = sourceCond(q.sourceIds, sql`l.source_id`);
  if (src) parts.push(src);
  const live = liveFilter(q);
  if (live) parts.push(live);
  return parts.length ? sql`l.id IS NOT NULL AND ${sql.join(parts, sql` AND `)}` : sql`true`;
}

/** Each conversation in a span, with its timings: the rows every part of the board is counted from. */
function conversations(q: AnalyticsQuery, span: { from: Date; to: Date }, now: Date): SQL {
  return sql`
    conv AS (
      SELECT t.id, t.account_id, t.created_at AS at, l.id AS lead_id, l.won_at, l.value,
             l.id IS NOT NULL AND l.created_at >= t.created_at AS new_lead,
             t.source ->> 'adId' AS ad_id,
             CASE coalesce(t.source ->> 'start', t.source ->> 'trigger')
                  WHEN 'comment' THEN 'comment' WHEN 'ad' THEN 'ad' WHEN 'story' THEN 'story' ELSE 'dm' END AS start
        FROM instagram_threads t
        LEFT JOIN leads l ON l.id = t.lead_id AND l.deleted_at IS NULL
       WHERE t.created_at >= ${span.from} AND t.created_at < ${span.to} AND ${leadCond(q)}),
    wrote AS (
      SELECT c.*, i.at AS in_at,
             CASE WHEN c.start = 'ad' THEN ${AD_WINDOW_S}::int ELSE ${WINDOW_S}::int END AS window_s
        FROM conv c
        LEFT JOIN LATERAL (
          SELECT a.occurred_at AS at FROM activities a
           WHERE a.lead_id = c.lead_id AND a.type = 'instagram_received' AND a.payload ->> 'threadId' = c.id::text
           ORDER BY a.occurred_at LIMIT 1) i ON c.lead_id IS NOT NULL),
    f AS (
      SELECT w.*, fl.at AS flow_at, tm.at AS team_at, least(fl.at, tm.at) AS answer_at
        FROM wrote w
        LEFT JOIN LATERAL (
          SELECT a.occurred_at AS at FROM activities a
           WHERE a.lead_id = w.lead_id AND a.occurred_at >= w.in_at AND a.type = 'instagram_confirmed_sent'
             AND a.payload ->> 'via' = 'flow' AND a.payload ->> 'threadId' = w.id::text
           ORDER BY a.occurred_at LIMIT 1) fl ON w.in_at IS NOT NULL
        LEFT JOIN LATERAL (
          SELECT a.occurred_at AS at FROM activities a
           WHERE a.lead_id = w.lead_id AND a.occurred_at >= w.in_at
             AND (a.type = 'instagram_sent'
                  OR (a.type = 'instagram_confirmed_sent' AND a.payload ->> 'via' IS DISTINCT FROM 'flow'))
             AND a.payload ->> 'threadId' = w.id::text
           ORDER BY a.occurred_at LIMIT 1) tm ON w.in_at IS NOT NULL),
    x AS (
      SELECT f.*,
             f.answer_at IS NOT NULL AND f.answer_at <= f.in_at + make_interval(secs => f.window_s) AS in_time,
             f.in_at IS NOT NULL AND f.in_at + make_interval(secs => f.window_s) <= ${now}::timestamptz
               AND NOT coalesce(f.answer_at <= f.in_at + make_interval(secs => f.window_s), false) AS ran_out,
             f.lead_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM meetings m WHERE m.lead_id = f.lead_id AND m.created_at >= f.at
                  AND m.status <> 'cancelled') AS booked,
             f.won_at IS NOT NULL AND f.won_at >= f.at AS won
        FROM f)`;
}

const median = (col: SQL) => sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ${col}))`;

async function totals(
  req: FastifyRequest,
  q: AnalyticsQuery,
  span: { from: Date; to: Date },
  now: Date,
  money: boolean,
): Promise<Totals> {
  const r = await req.db.execute<{
    conversations: number;
    leads: number;
    measured: number;
    in_time: number;
    ran_out: number;
    first_s: number | null;
    booked: number;
    won: number;
    booked_new: number;
    won_new: number;
    revenue: string | null;
    ad_clicks: number;
    comment: number;
    dm: number;
    ad: number;
    story: number;
  }>(sql`
    WITH ${conversations(q, span, now)}
    SELECT count(*)::int AS conversations, count(DISTINCT lead_id) FILTER (WHERE new_lead)::int AS leads,
           count(*) FILTER (WHERE in_time OR ran_out)::int AS measured,
           count(*) FILTER (WHERE in_time)::int AS in_time, count(*) FILTER (WHERE ran_out)::int AS ran_out,
           (${median(sql`answer_at - in_at`)} FILTER (WHERE answer_at IS NOT NULL))::float8 AS first_s,
           count(DISTINCT lead_id) FILTER (WHERE booked)::int AS booked,
           count(DISTINCT lead_id) FILTER (WHERE won)::int AS won,
           count(DISTINCT lead_id) FILTER (WHERE booked AND new_lead)::int AS booked_new,
           count(DISTINCT lead_id) FILTER (WHERE won AND new_lead)::int AS won_new,
           -- Each lead's value once, however many of its conversations started in the range.
           (SELECT coalesce(sum(w.value), 0) FROM (SELECT DISTINCT ON (lead_id) value FROM x WHERE won) w)::text
             AS revenue,
           count(*) FILTER (WHERE start = 'ad' AND in_at IS NOT NULL)::int AS ad_clicks,
           count(*) FILTER (WHERE start = 'comment')::int AS comment, count(*) FILTER (WHERE start = 'dm')::int AS dm,
           count(*) FILTER (WHERE start = 'ad')::int AS ad, count(*) FILTER (WHERE start = 'story')::int AS story
      FROM x`);
  const t = r.rows[0]!;
  // Private replies that went, and those who asked on Instagram to stop: each read by when it happened.
  const side = await req.db.execute<{ private_replies: number; stopped: number }>(sql`
    SELECT (SELECT count(*) FROM instagram_comments k
              LEFT JOIN instagram_threads t ON t.id = k.thread_id
              LEFT JOIN leads l ON l.id = t.lead_id AND l.deleted_at IS NULL
             WHERE k.private_reply = 'sent' AND k.private_reply_at >= ${span.from} AND k.private_reply_at < ${span.to}
               AND ${leadCond(q)})::int AS private_replies,
           (SELECT count(*) FROM leads l
             WHERE l.dnc_reason = 'Said stop on Instagram' AND l.dnc_at >= ${span.from} AND l.dnc_at < ${span.to}
               AND l.deleted_at IS NULL AND ${leadCond(q)})::int AS stopped`);
  const s = side.rows[0]!;
  return {
    conversations: t.conversations,
    leads: t.leads,
    measured: t.measured,
    inTime: t.in_time,
    ranOut: t.ran_out,
    firstAnswerSec: t.first_s === null ? null : Math.round(t.first_s),
    booked: t.booked,
    won: t.won,
    bookedNew: t.booked_new,
    wonNew: t.won_new,
    revenue: money ? Number(t.revenue) : null,
    adClicks: t.ad_clicks,
    privateReplies: s.private_replies,
    stopped: s.stopped,
    byStart: { comment: t.comment, dm: t.dm, ad: t.ad, story: t.story },
  };
}

/**
 * The Instagram board: its numbers for the range (and the one before, to compare), conversations by what started them
 * on each of the business's days, where people stop, who answered, each account, and the posts and ads that started
 * the most. Counts and timings only: no names or words.
 */
export async function instagramBoard(req: FastifyRequest, raw: AnalyticsQuery, now: Date) {
  const q = narrow(req, raw);
  assertLeadAccess(
    req,
    q.reach!,
    "Instagram's numbers are counted from the leads you can open, and you can open fewer than these numbers cover.",
  );
  const tz = await businessTz(req);
  const range = rangeOf(q, tz, now);
  guardLive(q, range);
  const money = seesRevenue(req);
  const cur = await totals(req, q, range, now, money);
  const prev = q.compare ? await totals(req, q, range.previous, now, money) : null;

  const daily = await req.db.execute<{ day: string; start: IgStart; n: number }>(sql`
    WITH ${conversations(q, range, now)}
    SELECT to_char((at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, start, count(*)::int AS n
      FROM conv GROUP BY 1, 2`);
  const per = new Map(daily.rows.map((r) => [`${r.day}|${r.start}`, r.n]));
  const series = range.days.map((day) => ({
    day,
    ...Object.fromEntries(IG_STARTS.map((k) => [k, per.get(`${day}|${k}`) ?? 0])),
  })) as ({ day: string } & Record<IgStart, number>)[];

  // Who answered: a conversation counts for each that answered it. LUME AI's row waits for LUME AI on Instagram.
  const who = await req.db.execute<{
    who: "flows" | "team";
    conversations: number;
    booked: number;
    won: number;
    revenue: string;
    first_s: number | null;
  }>(sql`
    WITH ${conversations(q, range, now)},
    ans AS (
      SELECT w.who, w.at AS who_at, x.* FROM x
       CROSS JOIN LATERAL (VALUES ('flows', x.flow_at), ('team', x.team_at)) AS w(who, at)
       WHERE w.at IS NOT NULL)
    SELECT a.who, count(*)::int AS conversations,
           count(DISTINCT a.lead_id) FILTER (WHERE a.booked)::int AS booked,
           count(DISTINCT a.lead_id) FILTER (WHERE a.won)::int AS won,
           (SELECT coalesce(sum(v.value), 0)
              FROM (SELECT DISTINCT ON (b.lead_id) b.value FROM ans b WHERE b.who = a.who AND b.won) v)::text AS revenue,
           (${median(sql`a.who_at - a.in_at`)})::float8 AS first_s
      FROM ans a
     GROUP BY a.who`);
  const answered = (k: "flows" | "team") => {
    const r = who.rows.find((x) => x.who === k);
    return {
      id: k,
      conversations: r?.conversations ?? 0,
      booked: r?.booked ?? 0,
      won: r?.won ?? 0,
      revenue: money ? Number(r?.revenue ?? 0) : null,
      firstAnswerSec: r?.first_s == null ? null : Math.round(r.first_s),
    };
  };

  const accounts = await req.db.execute<{
    id: string;
    username: string | null;
    status: string;
    conversations: number;
    leads: number;
  }>(sql`
    WITH ${conversations(q, range, now)}
    SELECT a.id, a.username, a.status, count(c.id)::int AS conversations,
           count(DISTINCT c.lead_id) FILTER (WHERE c.new_lead)::int AS leads
      FROM instagram_accounts a LEFT JOIN conv c ON c.account_id = a.id
     GROUP BY a.id, a.username, a.status
     ORDER BY count(c.id) DESC, a.username`);

  // The posts and ads that started the most: an ad click's ad, or the post of the comment that opened it.
  const sources = await req.db.execute<{
    kind: string;
    id: string;
    conversations: number;
    leads: number;
  }>(sql`
    WITH ${conversations(q, range, now)}
    SELECT s.kind, s.id, count(*)::int AS conversations,
           count(DISTINCT c.lead_id) FILTER (WHERE c.new_lead)::int AS leads
      FROM conv c
      CROSS JOIN LATERAL (
        SELECT CASE WHEN c.ad_id IS NOT NULL THEN 'ad' ELSE lower(coalesce(k.media_type, 'post')) END AS kind,
               coalesce(c.ad_id, k.media_id) AS id
          FROM (SELECT 1) one
          LEFT JOIN LATERAL (
            SELECT media_id, media_type FROM instagram_comments
             WHERE thread_id = c.id AND media_id IS NOT NULL ORDER BY at LIMIT 1) k ON c.ad_id IS NULL) s
     WHERE s.id IS NOT NULL
     GROUP BY s.kind, s.id
     ORDER BY count(DISTINCT c.lead_id) FILTER (WHERE c.new_lead) DESC, count(*) DESC, s.id
     LIMIT 10`);

  const rate = (a: number, b: number) => (b > 0 ? a / b : null);
  return {
    range: { from: range.days[0]!, to: range.days.at(-1)!, label: range.label },
    totals: cur,
    previous: prev,
    rates: {
      inTime: rate(cur.inTime, cur.measured),
      leadRate: rate(cur.leads, cur.conversations),
    },
    series,
    // Where people stop: everyone who started a conversation, then the leads made from them and how far those got
    // (each step within the one before).
    funnel: [
      { id: "wrote", n: cur.conversations },
      { id: "lead", n: cur.leads },
      { id: "booked", n: cur.bookedNew },
      { id: "won", n: cur.wonNew },
    ],
    whoAnswered: [answered("flows"), answered("team")],
    accounts: accounts.rows,
    sources: sources.rows,
  };
}

/** Whether the business has an Instagram account (connected now or before): Analytics shows its board then. */
export async function instagramThere(req: FastifyRequest): Promise<boolean> {
  const r = await req.db.execute<{ there: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM instagram_accounts) AS there`,
  );
  return r.rows[0]!.there;
}
