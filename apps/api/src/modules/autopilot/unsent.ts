import type pg from "pg";

/**
 * LUME AI's message was held by a Pause after its send step (spec 2026-10-19 §2.1): it never went, so it mustn't count
 * as gone, or pace what comes next. The lead goes back to where it was before it: a first message to Up next, a
 * follow-up to the one before, an answer to Replied; its last send is the last one that really went (held ones were
 * cancelled). Resume then writes it again. Only for a lead still LUME AI's in that run; anything that happened since
 * (the lead wrote again, a person took over) stands. Every outbox row of one message may call it: it's the same change
 * each time.
 */
export async function unsent(
  c: pg.PoolClient,
  o: { runId: string; leadId: string; template: boolean; at: Date },
): Promise<void> {
  const { rowCount } = await c.query(
    `WITH went AS (
       SELECT max(a.occurred_at) AS at FROM activities a
         JOIN whatsapp_outbox o ON o.id = (a.payload ->> 'outboxId')::uuid AND o.status <> 'cancelled'
        WHERE a.lead_id = $2 AND a.type = 'whatsapp_sent' AND a.payload ->> 'runId' = $1::uuid::text
     )
     UPDATE autopilot_leads
        SET state = CASE WHEN NOT $4::boolean THEN 'replied' WHEN follow_ups_sent = 0 THEN 'up_next' ELSE 'sent' END,
            first_sent_at = CASE WHEN $4::boolean AND follow_ups_sent = 0 THEN NULL ELSE first_sent_at END,
            last_sent_at = CASE WHEN $4::boolean AND follow_ups_sent = 0 THEN NULL
                                ELSE coalesce((SELECT at FROM went), first_sent_at) END,
            follow_ups_sent = CASE WHEN $4::boolean THEN greatest(follow_ups_sent - 1, 0) ELSE follow_ups_sent END,
            next_at = $3, updated_at = $3
      WHERE run_id = $1 AND lead_id = $2 AND active
        AND CASE WHEN $4::boolean THEN state = 'sent' ELSE state = 'talking' AND last_inbound_at IS NOT NULL END`,
    [o.runId, o.leadId, o.at, o.template],
  );
  if (rowCount)
    await c.query("INSERT INTO autopilot_events (run_id, lead_id, kind, at) VALUES ($1, $2, 'unsent', $3)", [
      o.runId,
      o.leadId,
      o.at,
    ]);
}
