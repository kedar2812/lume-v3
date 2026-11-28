import { sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { notFound } from "../../http/errors";
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

/**
 * A connected account's own photo (owner 2026-11-28), to those who manage integrations (the route's permission). An
 * account that isn't connected is a 404; one with no photo kept (none on Instagram, not looked at yet) is a 204: the
 * initials stay.
 */
export async function sendAccountPhoto(
  req: FastifyRequest,
  reply: FastifyReply,
  d: AppDeps,
  accountId: string,
) {
  const [a] = (
    await req.db.execute<{ photo_sha256: string | null; photo_mime: string | null }>(
      sql`SELECT photo_sha256, photo_mime FROM instagram_accounts WHERE id = ${accountId} AND status <> 'disconnected'`,
    )
  ).rows;
  if (!a) throw notFound("ACCOUNT_NOT_FOUND", "That Instagram account isn't connected to LUME.");
  const file = a.photo_sha256 ? await onDisk(d, a.photo_sha256) : null;
  if (!a.photo_sha256 || !a.photo_mime || !file)
    return reply.code(204).header("cache-control", "private, no-store").send();
  return streamFile(
    req,
    reply,
    file,
    { sha256: a.photo_sha256, mime: a.photo_mime, kind: "image", filename: null },
    PHOTO_CACHE_S,
  );
}
