import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError } from "../../http/errors";
import { clickToSend } from "../../messaging/channel";
import { assertTaskOf, assertVersion, sendable } from "./sending";
import { recordActivity } from "./service";

/**
 * Report §11.2 step 2: the link is built here and handed to the page, which opens it at once. It is
 * never listed, so a masked role never sees the number (§11.2 step 5).
 */
export async function prepareMessage(
  req: FastifyRequest,
  id: string,
  text: string,
  from: { templateVersionId?: string; taskId?: string; queueId?: string } = {},
) {
  // Who may message this lead, and never one in do not contact (Autopilot A2): the same gate every send passes.
  const lead = await sendable(req, id);
  if (lead.phoneStatus === "needs_country")
    throw new HttpError(
      422,
      "PHONE_NEEDS_COUNTRY",
      "This number needs a country code before WhatsApp can open it",
    );
  if (!lead.phoneE164 || lead.phoneStatus !== "valid")
    throw new HttpError(422, "NO_WHATSAPP_NUMBER", "This lead has no WhatsApp number");
  // A template's version is checked for the caller's role (4A); an edited or archived one still sends.
  if (from.templateVersionId) await assertVersion(req, from.templateVersionId);
  if (from.taskId) await assertTaskOf(req, id, from.taskId);
  const prepared = clickToSend.prepare({ e164: lead.phoneE164 }, text);
  await recordActivity(req, id, "whatsapp_opened", {
    text,
    channel: clickToSend.name,
    ...(from.templateVersionId ? { templateVersionId: from.templateVersionId } : {}),
    ...(from.taskId ? { taskId: from.taskId } : {}),
    // A queued send (4C): its run, so the daily cap counts it.
    ...(from.queueId ? { queueId: from.queueId } : {}),
  });
  // A message is contact: the lead isn't gone quiet (3C final review, Important 3).
  await req.db.update(schema.leads).set({ lastActivityAt: new Date() }).where(eq(schema.leads.id, id));
  await audit(req, { action: "lead.whatsapp.prepare", entityType: "lead", entityId: id });
  return prepared;
}
