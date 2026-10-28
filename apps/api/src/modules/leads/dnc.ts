import { canOnRecord } from "@lume/core";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
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
 * run (`byAi`: kept as LUME AI's, by null, with the run on the timeline). When the lead said it themselves, every
 * other lead with their number is do not contact too, as said on WhatsApp: they asked, not one lead (review W5). The
 * WhatsApp work that hears a stop sees every lead.
 */
export async function setDoNotContact(
  req: FastifyRequest,
  leadId: string,
  /** `byAi`: LUME AI in a run heard it; `fromLead`: the lead said stop on WhatsApp. Neither is a person's doing. */
  o: { reason: string; byAi?: { runId: string }; fromLead?: true },
): Promise<{ doNotContact: DoNotContact }> {
  const lead = await visibleLead(req, leadId);
  const person = !o.byAi && !o.fromLead;
  if (person && !canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
  const at = lead.dncAt ?? new Date();
  const by = person ? req.actor!.userId : null;
  if (!lead.dncAt) await mark(req, leadId, { at, by, reason: o.reason, byAi: o.byAi, fromLead: o.fromLead });
  if (!person && lead.phoneE164) {
    const L = schema.leads;
    const twins = await req.db
      .select({ id: L.id })
      .from(L)
      .where(and(eq(L.phoneE164, lead.phoneE164), ne(L.id, leadId), isNull(L.deletedAt), isNull(L.dncAt)));
    // Each on its own timeline, as said on WhatsApp (the run, if any, was this lead's).
    for (const t of twins) await mark(req, t.id, { at, by: null, reason: o.reason, fromLead: true });
  }
  return {
    doNotContact: {
      at: at.toISOString(),
      by: lead.dncAt ? lead.dncBy : by,
      reason: lead.dncAt ? lead.dncReason : o.reason,
    },
  };
}

async function mark(
  req: FastifyRequest,
  leadId: string,
  o: {
    at: Date;
    by: string | null;
    reason: string;
    byAi?: { runId: string } | undefined;
    fromLead?: true | undefined;
  },
) {
  await req.db
    .update(schema.leads)
    // A change to the lead like any other: its version moves, so a bulk undo never lifts it (review L1).
    .set({ dncAt: o.at, dncBy: o.by, dncReason: o.reason, version: sql`${schema.leads.version} + 1` })
    .where(eq(schema.leads.id, leadId));
  await recordActivity(req, leadId, "dnc_set", {
    reason: o.reason,
    ...(o.byAi ? { via: "ai_autopilot", runId: o.byAi.runId } : {}),
    ...(o.fromLead ? { via: "whatsapp" } : {}),
  });
  await audit(req, { action: "lead.dnc_set", entityType: "lead", entityId: leadId });
}

/** An admin lifts do not contact (the route asks `settings.manage`): messages may go again. */
export async function liftDoNotContact(req: FastifyRequest, leadId: string): Promise<{ doNotContact: null }> {
  const lead = await visibleLead(req, leadId);
  if (lead.dncAt) {
    await req.db
      .update(schema.leads)
      .set({ dncAt: null, dncBy: null, dncReason: null, version: sql`${schema.leads.version} + 1` })
      .where(eq(schema.leads.id, leadId));
    await recordActivity(req, leadId, "dnc_lifted");
    await audit(req, { action: "lead.dnc_lifted", entityType: "lead", entityId: leadId });
  }
  return { doNotContact: null };
}
