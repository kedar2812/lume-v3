import { canOnRecord, instagramWindow, maskInstagram } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { visibleLead } from "../leads/service";

const THREAD_MAX = 500;

type Msg = {
  id: string;
  direction: "in" | "out";
  at: string;
  text: string | null;
  /** What came with it: attachment kinds, a story, a tap, an ad (no Meta links). */
  detail: Record<string, unknown>;
  /** The person took it back on Instagram: its words are gone. */
  unsent: boolean;
  /** Sent from LUME: who, where it got to, and why it failed; null for the rest. */
  sentBy: { id: string; name: string } | null;
  status: "queued" | "sending" | "sent" | "read" | "failed" | "cancelled" | null;
  problem: string | null;
  reaction: string | null;
  outboxId: string | null;
  /** Sent from Instagram itself by someone at the business. */
  fromPhone: boolean;
  /** Sent with Meta's human agent tag (a person, after 24 hours). */
  humanAgent: boolean;
};

/**
 * A lead's Instagram conversations (NEW_FEATURES_PLAN §4.6), seen with the lead (404 otherwise): each conversation
 * with its account, Meta's window for it now, who has taken it over, and its newest 500 messages oldest first. The
 * person's handle is masked for anyone without full contact details on this lead, as the lead's own handle is.
 */
export async function leadInstagram(req: FastifyRequest, leadId: string, now: Date) {
  const lead = await visibleLead(req, leadId);
  const full = canOnRecord(req.actor!, "leads.contact.full", lead.ownerId);
  const threads = await req.db.execute<{
    id: string;
    account_id: string;
    account: string;
    account_status: string;
    username: string | null;
    name: string | null;
    last_in_at: Date | string | null;
    ad_window_until: Date | string | null;
    taken_over_by: string | null;
    taken_name: string | null;
    source: Record<string, unknown>;
  }>(sql`
    SELECT t.id, t.account_id, a.username AS account, a.status AS account_status, t.username, t.name,
           t.last_in_at, t.ad_window_until, t.taken_over_by, u.name AS taken_name, t.source
      FROM instagram_threads t
      JOIN instagram_accounts a ON a.id = t.account_id
      LEFT JOIN users u ON u.id = t.taken_over_by
     WHERE t.lead_id = ${leadId}
     ORDER BY t.last_message_at DESC NULLS LAST, t.created_at DESC`);
  if (!threads.rows.length) return { threads: [] };
  const ids = threads.rows.map((t) => t.id);
  const idList = `{${ids.join(",")}}`;
  const acts = await req.db.execute<{
    id: string;
    type: string;
    occurred_at: Date | string;
    payload: Record<string, unknown>;
  }>(sql`
    SELECT id, type, occurred_at, payload FROM (
      SELECT id, type, occurred_at, payload FROM activities
       WHERE lead_id = ${leadId} AND type IN ('instagram_received', 'instagram_sent', 'instagram_unsent')
         AND payload->>'threadId' = ANY(${idList}::text[])
       ORDER BY occurred_at DESC, id DESC LIMIT ${THREAD_MAX * 2}) x
    ORDER BY occurred_at, id`);
  const out = await req.db.execute<{
    id: string;
    thread_id: string;
    mid: string | null;
    user_id: string;
    user_name: string;
    text: string | null;
    status: Msg["status"];
    problem: string | null;
    reaction: string | null;
    tag: string | null;
    created_at: Date | string;
    quick_replies: unknown;
    buttons: unknown;
  }>(sql`
    SELECT o.id, o.thread_id, o.mid, o.user_id, u.name AS user_name, o.text, o.status, o.problem, o.reaction,
           o.tag, o.created_at, o.quick_replies, o.buttons
      FROM instagram_outbox o JOIN users u ON u.id = o.user_id
     WHERE o.thread_id = ANY(${`{${ids.join(",")}}`}::uuid[]) AND o.kind = 'dm'
     ORDER BY o.created_at DESC LIMIT ${THREAD_MAX}`);
  const unsent = new Set(
    acts.rows.filter((a) => a.type === "instagram_unsent").map((a) => String(a.payload.mid ?? "")),
  );
  const outMids = new Set(out.rows.map((o) => o.mid).filter(Boolean));
  const byThread = new Map<string, Msg[]>(ids.map((id) => [id, []]));
  for (const a of acts.rows) {
    if (a.type === "instagram_unsent") continue;
    const p = a.payload;
    const mid = String(p.mid ?? "");
    // A message LUME sent shows once, as its outbox row (with its status), never again as its echo.
    if (a.type === "instagram_sent" && outMids.has(mid)) continue;
    const gone = unsent.has(mid) || p.unsent === true;
    const { text, via } = p;
    // What came with it, without the bookkeeping keys the thread already says another way.
    const detail = Object.fromEntries(
      Object.entries(p).filter(
        ([k]) => !["mid", "accountId", "threadId", "text", "via", "unsent"].includes(k),
      ),
    );
    byThread.get(String(p.threadId))?.push({
      id: a.id,
      direction: a.type === "instagram_received" ? "in" : "out",
      at: new Date(a.occurred_at).toISOString(),
      text: gone ? null : typeof text === "string" ? text : null,
      detail: gone ? {} : detail,
      unsent: gone,
      sentBy: null,
      status: null,
      problem: null,
      reaction: null,
      outboxId: null,
      fromPhone: via === "echo",
      humanAgent: false,
    });
  }
  for (const o of out.rows)
    byThread.get(o.thread_id)?.push({
      id: o.id,
      direction: "out",
      at: new Date(o.created_at).toISOString(),
      text: o.text,
      detail: {
        ...(Array.isArray(o.quick_replies) ? { quickReplies: o.quick_replies } : {}),
        ...(Array.isArray(o.buttons) ? { buttons: o.buttons } : {}),
      },
      unsent: false,
      sentBy: { id: o.user_id, name: o.user_name },
      status: o.status,
      problem: o.problem,
      reaction: o.reaction,
      outboxId: o.id,
      fromPhone: false,
      humanAgent: o.tag === "human_agent",
    });
  return {
    threads: threads.rows.map((t) => {
      // Raw rows carry timestamps as text: read as moments here.
      const at = (v: Date | string | null) => (v === null ? null : new Date(v));
      const w = instagramWindow({ lastInAt: at(t.last_in_at), adWindowUntil: at(t.ad_window_until) }, now);
      const messages = (byThread.get(t.id) ?? []).sort((x, y) => x.at.localeCompare(y.at)).slice(-THREAD_MAX);
      return {
        id: t.id,
        account: { id: t.account_id, username: t.account, connected: t.account_status === "active" },
        person: {
          name: t.name,
          username: t.username ? (full ? `@${t.username}` : maskInstagram(t.username)) : null,
        },
        window:
          w.state === "closed"
            ? { state: w.state, since: w.since?.toISOString() ?? null }
            : { state: w.state, until: w.until.toISOString() },
        takenOver: t.taken_over_by ? { id: t.taken_over_by, name: t.taken_name ?? "" } : null,
        source: t.source,
        messages,
      };
    }),
  };
}
