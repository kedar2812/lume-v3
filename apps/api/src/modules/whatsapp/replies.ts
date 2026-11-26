import { instagramWindow, REPLY_MEANINGS, type ReplyMeaningGroup } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { loadFieldRegistry } from "../../leads/fields";
import { isFieldVisible } from "../leads/serialize";
import type { KeptMeaning } from "./meaning";

/** At most this many leads are listed in a group (its count is the whole); a bulk action takes a group's listed leads. */
const GROUP_MAX = 500;
/** WhatsApp's own window: free-form replies within 24 hours of the lead's last message (after it, a template). */
const WA_WINDOW_MS = 24 * 3_600_000;

export type ReplyChannel = "whatsapp" | "instagram";
/** The board's groups: a flow's hand-offs first, then what LUME AI read each reply to mean (D6a). */
export type ReplyBoardGroup = "flow_passed" | ReplyMeaningGroup;
export const REPLY_BOARD_GROUPS: readonly ReplyBoardGroup[] = ["flow_passed", ...REPLY_MEANINGS];

export type ReplyBoardLead = {
  leadId: string;
  name: string;
  /** When they last wrote, and what. */
  at: string;
  text: string | null;
  /** LUME AI's line on it; null when it wasn't read. */
  summary: string | null;
  doNotContact: boolean;
  /** Where they last wrote. */
  channel: ReplyChannel;
  /**
   * Whether a reply still reaches them there now: open (anyone, until), human (Instagram after 24 hours: a person,
   * until), closed (WhatsApp: an approved template still can; Instagram: nobody until they write again).
   */
  window: { state: "open" | "human" | "closed"; until: string | null };
  /** Whose lead it is (null: nobody's yet). */
  ownerName: string | null;
  /** Where the lead came from; null when it has none or this person can't see the field. */
  source: string | null;
  /** A flow passed them to the team: its name, and what its hand-off said. */
  flow?: { name: string; note: string | null };
};
export type ReplyBoard = {
  since: string;
  channel: ReplyChannel | "all";
  groups: { group: ReplyBoardGroup; count: number; leads: ReplyBoardLead[] }[];
};

type Row = {
  lead_id: string;
  name: string | null;
  type: "whatsapp_received" | "instagram_received";
  at: Date;
  text: string | null;
  in_flow: boolean;
  dnc_at: Date | null;
  dnc_reason: string | null;
  result: KeptMeaning | null;
  owner_name: string | null;
  source_name: string | null;
  last_in_at: Date | null;
  ad_window_until: Date | null;
};
type Handed = {
  lead_id: string;
  name: string | null;
  handed_at: Date;
  flow_name: string;
  note: string | null;
  text: string | null;
  reply_at: Date | null;
  dnc_at: Date | null;
  owner_name: string | null;
  source_name: string | null;
  last_in_at: Date | null;
  ad_window_until: Date | null;
};

const iso = (d: Date | string) => new Date(d).toISOString();
const windowOf = (
  channel: ReplyChannel,
  r: { at: Date; last_in_at: Date | null; ad_window_until: Date | null },
  now: Date,
): ReplyBoardLead["window"] => {
  if (channel === "whatsapp") {
    const until = new Date(r.at).getTime() + WA_WINDOW_MS;
    return until > now.getTime()
      ? { state: "open", until: iso(new Date(until)) }
      : { state: "closed", until: null };
  }
  const w = instagramWindow(
    {
      lastInAt: r.last_in_at ? new Date(r.last_in_at) : null,
      adWindowUntil: r.ad_window_until ? new Date(r.ad_window_until) : null,
    },
    now,
  );
  return w.state === "closed"
    ? { state: "closed", until: null }
    : { state: w.state, until: w.until.toISOString() };
};

/**
 * `GET /api/v1/whatsapp/replies?since&channel` (W2, spec 2026-10-18 §4.2; Instagram D6a): each lead's latest reply since
 * the moment, on WhatsApp, Instagram or either, once, under its newest; grouped by what LUME AI read it to mean, in the
 * board's order. A reply it didn't read is Not sure, and a lead who said stop (LUME's own list caught it) is Stop
 * messaging. A lead whose newest Instagram reply was said to a flow still talking to them is the flow's, and isn't
 * listed; one a flow passed to the team, that no person has answered or taken over since, while a person may still
 * answer, is listed first, under "A flow passed these to you". Only leads the person can see (row-level security).
 */
export async function replyBoard(
  req: FastifyRequest,
  since: Date,
  now: Date,
  channel: ReplyChannel | "all" = "all",
): Promise<ReplyBoard> {
  // Written into the query (from the enum, never from the request's own words), so the planner reads the replies'
  // partial index (migration 0133).
  const types = sql.raw(
    channel === "all"
      ? "'whatsapp_received', 'instagram_received'"
      : channel === "whatsapp"
        ? "'whatsapp_received'"
        : "'instagram_received'",
  );
  const reg = { actor: req.actor!, fields: await loadFieldRegistry(req) };
  const seesSource = isFieldVisible(reg, "source");
  const rows = (
    await req.db.execute<Row>(sql`
      SELECT latest.*, ow.name AS owner_name, src.name AS source_name, t.last_in_at, t.ad_window_until
        FROM (
          SELECT DISTINCT ON (a.lead_id) a.lead_id, l.name, a.type, a.occurred_at AS at, a.payload ->> 'text' AS text,
                 a.payload ? 'inFlow' AS in_flow, a.payload ->> 'threadId' AS thread_id, l.owner_id, l.source_id,
                 l.dnc_at, l.dnc_reason, r.result
            FROM activities a
            JOIN leads l ON l.id = a.lead_id AND l.deleted_at IS NULL
            LEFT JOIN ai_reads r ON r.task = 'reply_meaning' AND r.source_activity_id = a.id AND r.status = 'ok'
           WHERE a.type IN (${types}) AND a.occurred_at >= ${since}
           ORDER BY a.lead_id, a.occurred_at DESC, a.id DESC
        ) latest
        LEFT JOIN users ow ON ow.id = latest.owner_id
        LEFT JOIN lead_sources src ON src.id = latest.source_id
        -- A thread id that isn't one (never written by LUME) finds no thread, rather than failing the board.
        LEFT JOIN instagram_threads t ON latest.type = 'instagram_received'
              AND t.id = CASE WHEN latest.thread_id ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
                              THEN latest.thread_id::uuid END
       ORDER BY latest.at DESC`)
  ).rows;

  // A flow's hand-offs (Instagram only): the newest run on each conversation, ended handed since the moment, with
  // nobody answering or taking over after it.
  const handed =
    channel === "whatsapp"
      ? []
      : (
          await req.db.execute<Handed>(sql`
            SELECT DISTINCT ON (x.lead_id) x.lead_id, l.name, x.handed_at, f.name AS flow_name,
                   h.payload ->> 'note' AS note, last.text, last.at AS reply_at, l.dnc_at,
                   ow.name AS owner_name, src.name AS source_name, t.last_in_at, t.ad_window_until
              FROM (
                SELECT DISTINCT ON (r.thread_id) r.id, r.thread_id, r.lead_id, r.flow_id, r.status,
                       r.updated_at AS handed_at
                  FROM instagram_flow_runs r
                 WHERE r.thread_id IN (
                   SELECT thread_id FROM instagram_flow_runs WHERE status = 'handed' AND updated_at >= ${since})
                 ORDER BY r.thread_id, r.created_at DESC, r.id DESC
              ) x
              JOIN leads l ON l.id = x.lead_id AND l.deleted_at IS NULL
              JOIN instagram_threads t ON t.id = x.thread_id
              JOIN instagram_flows f ON f.id = x.flow_id
              LEFT JOIN users ow ON ow.id = l.owner_id
              LEFT JOIN lead_sources src ON src.id = l.source_id
              LEFT JOIN LATERAL (
                SELECT payload FROM activities
                 WHERE lead_id = x.lead_id AND type = 'instagram_flow_handed' AND payload ->> 'runId' = x.id::text
                 LIMIT 1) h ON true
              LEFT JOIN LATERAL (
                SELECT payload ->> 'text' AS text, occurred_at AS at FROM activities
                 WHERE lead_id = x.lead_id AND type = 'instagram_received' AND payload ->> 'threadId' = x.thread_id::text
                 ORDER BY occurred_at DESC, id DESC LIMIT 1) last ON true
             WHERE x.status = 'handed' AND x.handed_at >= ${since}
               AND (t.taken_over_at IS NULL OR t.taken_over_at < x.handed_at)
               AND NOT EXISTS (
                 SELECT 1 FROM instagram_outbox o
                  WHERE o.thread_id = x.thread_id AND o.flow_run_id IS NULL AND o.kind = 'dm'
                    AND o.status NOT IN ('failed', 'cancelled') AND o.created_at > x.handed_at)
               AND NOT EXISTS (
                 SELECT 1 FROM activities s
                  WHERE s.lead_id = x.lead_id AND s.type = 'instagram_sent'
                    AND s.payload ->> 'threadId' = x.thread_id::text AND s.occurred_at > x.handed_at)
             ORDER BY x.lead_id, x.handed_at DESC`)
        ).rows;

  const groups = new Map<ReplyBoardGroup, ReplyBoardLead[]>(REPLY_BOARD_GROUPS.map((g) => [g, []]));
  const passed = new Set<string>();
  for (const h of handed) {
    const w = windowOf(
      "instagram",
      { at: h.handed_at, last_in_at: h.last_in_at, ad_window_until: h.ad_window_until },
      now,
    );
    // Only while a person can still answer (Instagram's 7 days): after that it's nobody's to answer. Nor one who
    // asked not to be messaged since: theirs is Stop messaging.
    if (w.state === "closed" || h.dnc_at !== null) continue;
    passed.add(h.lead_id);
    groups.get("flow_passed")!.push({
      leadId: h.lead_id,
      name: h.name ?? "A lead",
      at: iso(h.reply_at ?? h.handed_at),
      text: h.text,
      summary: null,
      doNotContact: h.dnc_at !== null,
      channel: "instagram",
      window: w,
      ownerName: h.owner_name,
      source: seesSource ? h.source_name : null,
      flow: { name: h.flow_name, note: h.note?.trim() || null },
    });
  }
  groups.get("flow_passed")!.sort((a, b) => b.at.localeCompare(a.at));
  for (const r of rows) {
    if (passed.has(r.lead_id) || r.in_flow) continue;
    const ch: ReplyChannel = r.type === "instagram_received" ? "instagram" : "whatsapp";
    const saidStop =
      r.dnc_at !== null &&
      (r.dnc_reason === "Said stop on WhatsApp" || r.dnc_reason === "Said stop on Instagram");
    const group: ReplyBoardGroup = r.result?.meaning ?? (saidStop ? "stop" : "not_sure");
    groups.get(group)!.push({
      leadId: r.lead_id,
      name: r.name ?? "A lead",
      at: iso(r.at),
      text: r.text,
      summary: r.result?.suggestion.summary ?? null,
      doNotContact: r.dnc_at !== null,
      channel: ch,
      window: windowOf(ch, r, now),
      ownerName: r.owner_name,
      source: seesSource ? r.source_name : null,
    });
  }
  return {
    since: since.toISOString(),
    channel,
    groups: REPLY_BOARD_GROUPS.map((group) => {
      const all = groups.get(group)!;
      return { group, count: all.length, leads: all.slice(0, GROUP_MAX) };
    }),
  };
}
