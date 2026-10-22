import { canOnRecord } from "@lume/core";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { forbidden } from "../../http/errors";
import { visibleLead } from "./service";
import { recordActivity } from "./writer";

export type DoNotContact = { at: string; by: string | null; reason: string | null } | null;

/**
 * Do not contact (Autopilot spec 2026-10-19 §1.3, §3): from now, no one in LUME can message this lead (every send checks
 * it, `sendable` and the outbox job). Set by someone who may edit the lead, or by LUME AI for a lead who said stop in a
 * run (`byAi`: kept as LUME AI's, by null, with the run on the timeline).
 */
export async function setDoNotContact(
  req: FastifyRequest,
  leadId: string,
  o: { reason: string; byAi?: { runId: string } },
): Promise<{ doNotContact: DoNotContact }> {
  const lead = await visibleLead(req, leadId);
  if (!o.byAi && !canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
  const at = lead.dncAt ?? new Date();
  const by = o.byAi ? null : req.actor!.userId;
  if (!lead.dncAt) {
    await req.db
      .update(schema.leads)
      .set({ dncAt: at, dncBy: by, dncReason: o.reason })
      .where(eq(schema.leads.id, leadId));
    await recordActivity(req, leadId, "dnc_set", {
      reason: o.reason,
      ...(o.byAi ? { via: "ai_autopilot", runId: o.byAi.runId } : {}),
    });
    await audit(req, { action: "lead.dnc_set", entityType: "lead", entityId: leadId });
  }
  return {
    doNotContact: {
      at: at.toISOString(),
      by: lead.dncAt ? lead.dncBy : by,
      reason: lead.dncAt ? lead.dncReason : o.reason,
    },
  };
}

/** An admin lifts do not contact (the route asks `settings.manage`): messages may go again. */
export async function liftDoNotContact(req: FastifyRequest, leadId: string): Promise<{ doNotContact: null }> {
  const lead = await visibleLead(req, leadId);
  if (lead.dncAt) {
    await req.db
      .update(schema.leads)
      .set({ dncAt: null, dncBy: null, dncReason: null })
      .where(eq(schema.leads.id, leadId));
    await recordActivity(req, leadId, "dnc_lifted");
    await audit(req, { action: "lead.dnc_lifted", entityType: "lead", entityId: leadId });
  }
  return { doNotContact: null };
}
