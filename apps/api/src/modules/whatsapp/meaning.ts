import {
  cleanReplyMeaning,
  replyMeaningInput,
  replyMeaningInstructions,
  replyMeaningOutput,
  type NextStep,
  type ReplyMeaning,
} from "@lume/core";
import { sql } from "drizzle-orm";
import { loadActor } from "../../rbac/actor";
import { leadFacts } from "../ai/facts";
import { runRead } from "../ai/service";
import { jobServer, withJobRequest } from "../imports/job-request";
import { setDoNotContact } from "../leads/dnc";
import { visibleLead } from "../leads/service";
import { notify } from "../notifications/notify";
import type { WhatsAppJobDeps } from "./process";
import { allScope } from "./sender";

/** What's kept on a reply's read: its meaning, and the next step in the shape Apply already knows. */
export type KeptMeaning = {
  meaning: ReplyMeaning["meaning"];
  stop: boolean;
  suggestion: NextStep;
  stageAtRead: string;
};

const firstName = (n: string | null) => n?.trim().split(/\s+/)[0] || null;

/**
 * LUME AI reads what one WhatsApp reply means (W2, spec 2026-10-18 §5.1): once per reply, as whoever connected the
 * number, against the month like every read. Skipped when the reply has no words, the lead is in an active Autopilot
 * run (its own read answers them), or it was read already. A stop it hears marks the lead do not contact at once, like
 * one LUME's own list catches, and the lead's owner hears.
 */
export async function readReplyMeaning(o: WhatsAppJobDeps, activityId: string): Promise<void> {
  const { d } = o;
  const pool = d.jobPool ?? d.pool;
  // Who runs it: whoever connected the number the reply came to (read with every lead in reach: row-level security).
  const { rows } = await allScope(pool, (c) =>
    c.query<{ run_as: string | null }>(
      `SELECT n.run_as FROM activities a
         JOIN whatsapp_numbers n ON n.id = (a.payload ->> 'numberId')::uuid
        WHERE a.id = $1 AND a.type = 'whatsapp_received'`,
      [activityId],
    ),
  );
  const actor = rows[0]?.run_as ? await loadActor(pool, rows[0].run_as) : null;
  if (!actor) return;
  const stopped = await withJobRequest(
    { app: jobServer(o.app), pool, actor, requestId: `whatsapp-meaning:${activityId}`, allLeads: true },
    async (req) => {
      const act = (
        await req.db.execute<{ lead_id: string; text: string | null; at: Date }>(sql`
          SELECT lead_id, payload ->> 'text' AS text, occurred_at AS at FROM activities
           WHERE id = ${activityId} AND type = 'whatsapp_received'`)
      ).rows[0];
      const reply = act?.text?.trim();
      if (!act || !reply) return null;
      const done = await req.db.execute(sql`
        SELECT 1 FROM ai_reads WHERE task = 'reply_meaning' AND source_activity_id = ${activityId} LIMIT 1`);
      if (done.rows.length) return null;
      const running = await req.db.execute(
        sql`SELECT 1 FROM autopilot_leads WHERE lead_id = ${act.lead_id} AND active LIMIT 1`,
      );
      if (running.rows.length) return null;
      const lead = await visibleLead(req, act.lead_id);
      const facts = await leadFacts(req, d, lead);
      const thread = (
        await req.db.execute<{ type: string; at: Date; text: string | null }>(sql`
          SELECT type, occurred_at AS at, payload ->> 'text' AS text FROM activities
           WHERE lead_id = ${lead.id} AND type IN ('whatsapp_received', 'whatsapp_sent') AND occurred_at <= ${act.at}
           ORDER BY occurred_at DESC, id DESC LIMIT 12`)
      ).rows
        .reverse()
        .filter((m) => m.text)
        .map((m) => ({
          from: m.type === "whatsapp_received" ? ("lead" as const) : ("business" as const),
          at: new Date(m.at).toISOString(),
          text: m.text!,
        }));
      const r = await runRead(req, d, {
        task: "reply_meaning",
        leadId: lead.id,
        sourceActivityId: activityId,
        instructions: replyMeaningInstructions,
        input: replyMeaningInput(facts, thread, reply),
        schema: replyMeaningOutput,
        maxOutputTokens: 1000,
        clean: (out) => cleanReplyMeaning(out, facts),
        store: (out): KeptMeaning => ({
          meaning: out.meaning,
          stop: out.stop,
          suggestion: {
            summary: out.summary,
            stageId: out.stageId,
            followUp: out.followUp,
            lostReasonId: out.lostReasonId,
            tagIds: [],
            decisionMaker: null,
          },
          stageAtRead: lead.stageId,
        }),
      });
      if ("unavailable" in r || !r.output.stop || lead.dncAt) return null;
      await setDoNotContact(req, lead.id, { reason: "Said stop on WhatsApp", fromLead: true });
      return lead.ownerId ? { ownerId: lead.ownerId, leadId: lead.id, name: lead.name } : null;
    },
  );
  if (stopped)
    await notify(pool, stopped.ownerId, {
      kind: "lead_stopped",
      title: `${firstName(stopped.name) ?? "A lead"} asked not to be messaged`,
      leadId: stopped.leadId,
    }).catch((err: unknown) => o.app.log.warn({ err }, "couldn't tell a lead's owner about a stop"));
}
