import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

export type LeadPhoto = { sha256: string; mime: string };

/**
 * Each lead's Instagram profile photo, for a page of leads in one query (the conversations' lead index), never one
 * query per lead. A lead with conversations on two accounts shows the photo looked at most recently. Row-level
 * security decides which conversations the caller sees, as it does for the leads.
 */
export async function photosFor(req: FastifyRequest, ids: string[]): Promise<Map<string, LeadPhoto>> {
  const out = new Map<string, LeadPhoto>();
  if (!ids.length) return out;
  const r = await req.db.execute<{ lead_id: string; photo_sha256: string; photo_mime: string }>(sql`
    SELECT DISTINCT ON (lead_id) lead_id, photo_sha256, photo_mime FROM instagram_threads
     WHERE lead_id = ANY(${`{${ids.join(",")}}`}::uuid[]) AND photo_sha256 IS NOT NULL
     ORDER BY lead_id, photo_checked_at DESC NULLS LAST`);
  for (const x of r.rows) out.set(x.lead_id, { sha256: x.photo_sha256, mime: x.photo_mime });
  return out;
}

/** Where a lead's photo is served: the hash in the address, so a new photo is a new address and the old can be kept. */
export const photoUrl = (leadId: string, p: LeadPhoto) =>
  `/api/v1/leads/${leadId}/photo?v=${p.sha256.slice(0, 12)}`;
