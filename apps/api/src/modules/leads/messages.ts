import type { FastifyRequest } from "fastify";
import { canOnRecord } from "@lume/core";
import { audit } from "../../audit/audit";
import { HttpError, forbidden } from "../../http/errors";
import { clickToSend } from "../../messaging/channel";
import { recordActivity, visibleLead } from "./service";

/**
 * Report §11.2 step 2: the link is built here and handed to the page, which opens it at once. It is
 * never listed, so a masked role never sees the number (§11.2 step 5).
 */
export async function prepareMessage(req: FastifyRequest, id: string, text: string) {
  const lead = await visibleLead(req, id);
  if (!canOnRecord(req.actor!, "messages.send", lead.ownerId)) throw forbidden();
  if (lead.phoneStatus === "needs_country")
    throw new HttpError(
      422,
      "PHONE_NEEDS_COUNTRY",
      "This number needs a country code before WhatsApp can open it",
    );
  if (!lead.phoneE164 || lead.phoneStatus !== "valid")
    throw new HttpError(422, "NO_WHATSAPP_NUMBER", "This lead has no WhatsApp number");
  const prepared = clickToSend.prepare({ e164: lead.phoneE164 }, text);
  await recordActivity(req, id, "whatsapp_opened", { text, channel: clickToSend.name });
  await audit(req, { action: "lead.whatsapp.prepare", entityType: "lead", entityId: id });
  return prepared;
}

/** Report §11.2 step 4: the answer to "Sent?" when the person comes back. */
export async function confirmMessage(req: FastifyRequest, id: string, sent: boolean) {
  const lead = await visibleLead(req, id);
  if (!canOnRecord(req.actor!, "messages.send", lead.ownerId)) throw forbidden();
  await recordActivity(req, id, sent ? "whatsapp_confirmed_sent" : "whatsapp_not_sent");
}
