import { REPLY_MEANINGS, type ReplyMeaningGroup } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { KeptMeaning } from "./meaning";

/** At most this many leads are listed in a group (its count is the whole); a bulk action takes a group's listed leads. */
const GROUP_MAX = 500;

export type ReplyBoardLead = {
  leadId: string;
  name: string;
  /** When they last wrote, and what. */
  at: string;
  text: string | null;
  /** LUME AI's line on it; null when it wasn't read. */
  summary: string | null;
  doNotContact: boolean;
};
export type ReplyBoard = {
  since: string;
  groups: { group: ReplyMeaningGroup; count: number; leads: ReplyBoardLead[] }[];
};

/**
 * `GET /api/v1/whatsapp/replies?since` (W2, spec 2026-10-18 §4.2): each lead's latest WhatsApp reply since the moment,
 * grouped by what LUME AI read it to mean, in the board's order; a reply it didn't read is Not sure, and a lead who said
 * stop (LUME's own list caught it) is Stop messaging. Only leads the person can see (row-level security), newest first.
 */
export async function replyBoard(req: FastifyRequest, since: Date): Promise<ReplyBoard> {
  const rows = (
    await req.db.execute<{
      lead_id: string;
      name: string | null;
      at: Date;
      text: string | null;
      dnc_at: Date | null;
      dnc_reason: string | null;
      result: KeptMeaning | null;
    }>(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (a.lead_id) a.lead_id, l.name, a.occurred_at AS at, a.payload ->> 'text' AS text,
               l.dnc_at, l.dnc_reason, r.result
          FROM activities a
          JOIN leads l ON l.id = a.lead_id AND l.deleted_at IS NULL
          LEFT JOIN ai_reads r ON r.task = 'reply_meaning' AND r.source_activity_id = a.id AND r.status = 'ok'
         WHERE a.type = 'whatsapp_received' AND a.occurred_at >= ${since}
         ORDER BY a.lead_id, a.occurred_at DESC, a.id DESC
      ) latest
      ORDER BY at DESC`)
  ).rows;
  const groups = new Map<ReplyMeaningGroup, ReplyBoardLead[]>(REPLY_MEANINGS.map((g) => [g, []]));
  for (const r of rows) {
    const saidStop = r.dnc_at !== null && r.dnc_reason === "Said stop on WhatsApp";
    const group: ReplyMeaningGroup = r.result?.meaning ?? (saidStop ? "stop" : "not_sure");
    groups.get(group)!.push({
      leadId: r.lead_id,
      name: r.name ?? "A lead",
      at: new Date(r.at).toISOString(),
      text: r.text,
      summary: r.result?.suggestion.summary ?? null,
      doNotContact: r.dnc_at !== null,
    });
  }
  return {
    since: since.toISOString(),
    groups: REPLY_MEANINGS.map((group) => {
      const all = groups.get(group)!;
      return { group, count: all.length, leads: all.slice(0, GROUP_MAX) };
    }),
  };
}
