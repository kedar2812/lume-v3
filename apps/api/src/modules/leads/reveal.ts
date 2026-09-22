import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { canOnRecord, formatPhone } from "@lume/core";
import { audit } from "../../audit/audit";
import { forbidden } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { isFieldVisible } from "./serialize";
import { recordActivity, visibleLead } from "./service";

/** Report §12.2 #3: one lead's contact on click, audited and counted per user per hour. */
export async function revealContact(req: FastifyRequest, id: string) {
  const actor = req.actor!;
  const lead = await visibleLead(req, id);
  if (
    !canOnRecord(actor, "leads.contact.reveal", lead.ownerId) &&
    !canOnRecord(actor, "leads.contact.full", lead.ownerId)
  )
    throw forbidden();
  const fields = await loadFieldRegistry(req);
  const ctx = { actor, fields };
  const out = {
    phone: isFieldVisible(ctx, "phone")
      ? lead.phoneE164
        ? formatPhone(lead.phoneE164)
        : lead.phoneRaw
      : null,
    email: isFieldVisible(ctx, "email") ? (lead.email?.toLowerCase() ?? null) : null,
    instagram: isFieldVisible(ctx, "instagram") && lead.instagramHandle ? `@${lead.instagramHandle}` : null,
  };
  await req.db.execute(sql`
    INSERT INTO reveal_counters (user_id, hour, count) VALUES (${actor.userId}, date_trunc('hour', now()), 1)
    ON CONFLICT (user_id, hour) DO UPDATE SET count = reveal_counters.count + 1`);
  await recordActivity(req, id, "contact_revealed");
  await audit(req, { action: "lead.contact.reveal", entityType: "lead", entityId: id });
  return out;
}
