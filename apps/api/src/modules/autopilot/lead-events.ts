import { ACTIVE_STATES, isStop, type LeadState } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { setDoNotContact } from "../leads/dnc";

/**
 * What LUME AI asked about for this lead was prepared for the lead as it was: once the lead writes again, says stop, or a
 * person takes the conversation, it's gone, never approved into a stale message (review 2026-10-26 A3).
 */
export async function asksGone(req: FastifyRequest, leadId: string): Promise<void> {
  await req.db.execute(
    sql`UPDATE autopilot_asks SET status = 'gone', decided_at = now() WHERE lead_id = ${leadId} AND status = 'waiting'`,
  );
}

/**
 * A lead in a LUME AI run wrote on WhatsApp (spec 2026-10-19 §3). Stop, in any words, is kept at once, whatever the run
 * is doing (paused, or LUME AI off): do not contact, out of the run. Anything else makes the lead "replied", for LUME AI
 * to answer inside the 24 hours; a lead with a person (ready, needs you, with you) only notes when they wrote.
 * Returns the run, and whether it was a stop, for the caller to wake the run (and send the one apology) after commit.
 */
export async function leadWrote(
  req: FastifyRequest,
  leadId: string,
  at: Date,
  text: string,
  /**
   * Where they wrote: only a run working that app (on Instagram, that account) answers it. A lead a WhatsApp run holds
   * who writes on Instagram is never answered on WhatsApp, nor the other way round (plan 2026-11-27-instagram-lume-ai).
   */
  on: { channel: "whatsapp" } | { channel: "instagram"; accountId: string } = { channel: "whatsapp" },
): Promise<{ runId: string; stopped: boolean; running: boolean; ready?: true } | null> {
  const where =
    on.channel === "instagram"
      ? sql`r.channel = 'instagram' AND r.instagram_account_id = ${on.accountId}`
      : sql`r.channel = 'whatsapp'`;
  const row = (
    await req.db.execute<{ run_id: string; state: string; status: string; goal: string }>(sql`
      SELECT l.run_id, l.state, r.status, coalesce(l.goal, r.goal) ->> 'kind' AS goal
        FROM autopilot_leads l JOIN autopilot_runs r ON r.id = l.run_id
       WHERE l.lead_id = ${leadId} AND l.active AND ${where} FOR UPDATE OF l`)
  ).rows[0];
  if (!row) return null;
  await asksGone(req, leadId);
  const running = row.status === "running";
  if (isStop(text)) {
    // The one apology is LUME AI's to send only while it holds the conversation: never into a person's (A10).
    const aiHolds = ACTIVE_STATES.includes(row.state as LeadState);
    await setDoNotContact(req, leadId, {
      reason: on.channel === "instagram" ? "Said stop on Instagram" : "Said stop on WhatsApp",
      byAi: { runId: row.run_id },
    });
    await req.db.execute(sql`
      UPDATE autopilot_leads SET state = 'stopped', active = false, draft = NULL, draft_payload = NULL, next_at = NULL,
             reason = 'Said stop. LUME AI marked them do not contact.', last_inbound_at = ${at}, updated_at = now()
       WHERE run_id = ${row.run_id} AND lead_id = ${leadId}`);
    await req.db.execute(
      sql`INSERT INTO autopilot_events (run_id, lead_id, kind) VALUES (${row.run_id}, ${leadId}, 'stopped')`,
    );
    return { runId: row.run_id, stopped: true, running: running && aiHolds };
  }
  const working = ["up_next", "writing", "sent", "replied", "talking"].includes(row.state);
  if (row.goal === "reply" && working) {
    // "Get a reply" (§1.1): a reply is the goal reached. Ready for you, with their own words.
    const card = JSON.stringify({ headline: "Replied", quote: text || null });
    await req.db.execute(sql`
      UPDATE autopilot_leads SET state = 'ready', card = ${card}::jsonb, reason = 'Replied', last_inbound_at = ${at},
             draft = NULL, draft_payload = NULL, next_at = NULL, updated_at = now()
       WHERE run_id = ${row.run_id} AND lead_id = ${leadId}`);
    await req.db.execute(
      sql`INSERT INTO autopilot_events (run_id, lead_id, kind) VALUES (${row.run_id}, ${leadId}, 'ready')`,
    );
    return { runId: row.run_id, stopped: false, running, ready: true };
  }
  if (working) {
    // A first message or a follow-up still being written is now the wrong message: LUME AI answers them instead.
    await req.db.execute(sql`
      UPDATE autopilot_leads SET state = 'replied', last_inbound_at = ${at}, follow_ups_sent = 0, draft = NULL,
             draft_payload = NULL, next_at = ${at}, updated_at = now()
       WHERE run_id = ${row.run_id} AND lead_id = ${leadId}`);
    await req.db.execute(
      sql`INSERT INTO autopilot_events (run_id, lead_id, kind) VALUES (${row.run_id}, ${leadId}, 'replied')`,
    );
  } else
    await req.db.execute(sql`
      UPDATE autopilot_leads SET last_inbound_at = ${at}, updated_at = now()
       WHERE run_id = ${row.run_id} AND lead_id = ${leadId}`);
  return { runId: row.run_id, stopped: false, running };
}

/**
 * A person messaged a lead in a run, from LUME or from the business's phone (spec §3): it's theirs now ("With you"); a
 * message LUME AI was writing stays as it was. LUME AI's own sends never come here.
 */
export async function personSent(
  req: FastifyRequest,
  leadId: string,
  /** Where the person wrote: only a run in that app (on Instagram, that account) is theirs now (review 2026-11-27 I2). */
  on: { channel: "whatsapp" } | { channel: "instagram"; accountId: string } = { channel: "whatsapp" },
): Promise<void> {
  const where =
    on.channel === "instagram"
      ? sql`r.channel = 'instagram' AND r.instagram_account_id = ${on.accountId}`
      : sql`r.channel = 'whatsapp'`;
  const r = await req.db.execute<{ run_id: string }>(sql`
    UPDATE autopilot_leads l SET state = 'with_you', next_at = NULL, updated_at = now()
      FROM autopilot_runs r
     WHERE r.id = l.run_id AND l.lead_id = ${leadId} AND l.active AND l.state <> 'with_you' AND ${where}
     RETURNING l.run_id`);
  if (r.rows.length) await asksGone(req, leadId);
  for (const x of r.rows)
    await req.db.execute(
      sql`INSERT INTO autopilot_events (run_id, lead_id, kind) VALUES (${x.run_id}, ${leadId}, 'with_you')`,
    );
}

/**
 * Hand back an Instagram conversation (spec 2026-11-22 §1.3): LUME AI's again where its run on this account still holds
 * the lead, to answer what's unanswered (once Instagram's 24 hours are over, the run gives it to a person instead).
 * Answers the run to wake, if any.
 */
export async function handedBack(
  req: FastifyRequest,
  leadId: string,
  accountId: string,
): Promise<string | null> {
  // Unanswered means their last message came after the business's last one, whoever sent it (a person's included).
  const r = await req.db.execute<{ run_id: string }>(sql`
    UPDATE autopilot_leads l
       SET state = CASE WHEN t.last_in_at IS NOT NULL
                         AND t.last_in_at > coalesce(greatest(t.last_out_at, l.last_sent_at), '-infinity')
                        THEN 'replied' ELSE 'talking' END,
           last_inbound_at = coalesce(t.last_in_at, l.last_inbound_at),
           last_sent_at = greatest(t.last_out_at, l.last_sent_at),
           next_at = now(), updated_at = now()
      FROM autopilot_runs r, instagram_threads t
     WHERE r.id = l.run_id AND l.lead_id = ${leadId} AND l.active AND l.state = 'with_you'
       AND r.channel = 'instagram' AND r.instagram_account_id = ${accountId}
       AND t.account_id = ${accountId} AND t.lead_id = ${leadId}
     RETURNING l.run_id`);
  const runId = r.rows[0]?.run_id ?? null;
  if (runId)
    await req.db.execute(
      sql`INSERT INTO autopilot_events (run_id, lead_id, kind) VALUES (${runId}, ${leadId}, 'replied')`,
    );
  return runId;
}
