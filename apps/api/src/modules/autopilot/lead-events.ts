import { isStop } from "@lume/core";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { setDoNotContact } from "../leads/dnc";

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
): Promise<{ runId: string; stopped: boolean; running: boolean; ready?: true } | null> {
  const row = (
    await req.db.execute<{ run_id: string; state: string; status: string; goal: string }>(sql`
      SELECT l.run_id, l.state, r.status, r.goal ->> 'kind' AS goal
        FROM autopilot_leads l JOIN autopilot_runs r ON r.id = l.run_id
       WHERE l.lead_id = ${leadId} AND l.active FOR UPDATE OF l`)
  ).rows[0];
  if (!row) return null;
  const running = row.status === "running";
  if (isStop(text)) {
    await setDoNotContact(req, leadId, { reason: "Said stop on WhatsApp", byAi: { runId: row.run_id } });
    await req.db.execute(sql`
      UPDATE autopilot_leads SET state = 'stopped', active = false, draft = NULL, draft_payload = NULL, next_at = NULL,
             reason = 'Said stop. LUME AI marked them do not contact.', last_inbound_at = ${at}, updated_at = now()
       WHERE run_id = ${row.run_id} AND lead_id = ${leadId}`);
    await req.db.execute(
      sql`INSERT INTO autopilot_events (run_id, lead_id, kind) VALUES (${row.run_id}, ${leadId}, 'stopped')`,
    );
    return { runId: row.run_id, stopped: true, running };
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
export async function personSent(req: FastifyRequest, leadId: string): Promise<void> {
  const r = await req.db.execute<{ run_id: string }>(sql`
    UPDATE autopilot_leads SET state = 'with_you', next_at = NULL, updated_at = now()
     WHERE lead_id = ${leadId} AND active AND state <> 'with_you'
     RETURNING run_id`);
  for (const x of r.rows)
    await req.db.execute(
      sql`INSERT INTO autopilot_events (run_id, lead_id, kind) VALUES (${x.run_id}, ${leadId}, 'with_you')`,
    );
}
