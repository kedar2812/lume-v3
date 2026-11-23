import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { loadFieldRegistry } from "../../leads/fields";
import { isFieldVisible } from "../leads/serialize";
import { visibleLead } from "../leads/service";
import { onDisk, streamFile } from "../whatsapp/media";
import { photosFor } from "./photos-of";

const PHOTO_CACHE_S = 300;

/**
 * The photo itself, to whoever sees the lead and its name. A lead out of reach is a 404, exactly as a missing one; a
 * lead in reach with no photo (or its name hidden from the caller) is a 204: nothing to show, initials stay.
 */
export async function sendLeadPhoto(req: FastifyRequest, reply: FastifyReply, d: AppDeps, leadId: string) {
  const lead = await visibleLead(req, leadId);
  const none = () => reply.code(204).header("cache-control", "private, no-store").send();
  if (!isFieldVisible({ actor: req.actor!, fields: await loadFieldRegistry(req) }, "name")) return none();
  const p = (await photosFor(req, [lead.id])).get(lead.id);
  const file = p ? await onDisk(d, p.sha256) : null;
  if (!p || !file) return none();
  return streamFile(
    req,
    reply,
    file,
    { sha256: p.sha256, mime: p.mime, kind: "image", filename: null },
    // Five minutes, never "immutable": after a data deletion, or once the name is hidden from a role, the browser
    // asks again soon (a 304 while nothing changed) instead of showing the photo for a day.
    PHOTO_CACHE_S,
  );
}
