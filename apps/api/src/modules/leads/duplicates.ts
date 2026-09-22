import { and, inArray, isNull, or, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { contactKeyHash, schema } from "@lume/db";

type Kind = "phone" | "email" | "instagram";
export type Duplicate =
  | { visible: true; leadId: string; name: string; ownerName: string | null; matchedOn: Kind[] }
  | { visible: false; matchedOn: Kind[] };

/**
 * Report §8.3: warn about existing leads with the same phone/email/Instagram across *all* leads, but only
 * describe the ones the caller may see. Matching uses hashes (lead_contact_keys), never plaintext.
 */
export async function findDuplicates(
  req: FastifyRequest,
  c: { phoneE164?: string | null; email?: string | null; instagram?: string | null },
  excludeLeadId?: string,
): Promise<Duplicate[]> {
  const probes: { kind: Kind; hash: string }[] = [];
  if (c.phoneE164) probes.push({ kind: "phone", hash: contactKeyHash("phone", c.phoneE164) });
  if (c.email) probes.push({ kind: "email", hash: contactKeyHash("email", c.email.toLowerCase()) });
  if (c.instagram)
    probes.push({ kind: "instagram", hash: contactKeyHash("instagram", c.instagram.toLowerCase()) });
  if (!probes.length) return [];
  const hits = await req.db
    .select()
    .from(schema.leadContactKeys)
    .where(
      or(
        ...probes.map((p) =>
          and(eq(schema.leadContactKeys.kind, p.kind), eq(schema.leadContactKeys.keyHash, p.hash)),
        ),
      ),
    );
  const byLead = new Map<string, Kind[]>();
  for (const h of hits)
    if (h.leadId !== excludeLeadId) byLead.set(h.leadId, [...(byLead.get(h.leadId) ?? []), h.kind]);
  if (!byLead.size) return [];
  // RLS decides which of these the caller may learn about.
  const visible = await req.db
    .select({ id: schema.leads.id, name: schema.leads.name, ownerName: schema.users.name })
    .from(schema.leads)
    .leftJoin(schema.users, eq(schema.users.id, schema.leads.ownerId))
    .where(and(inArray(schema.leads.id, [...byLead.keys()]), isNull(schema.leads.deletedAt)));
  const seen = new Map(visible.map((v) => [v.id, v]));
  return [...byLead].map(([leadId, matchedOn]) => {
    const v = seen.get(leadId);
    return v
      ? { visible: true as const, leadId, name: v.name, ownerName: v.ownerName, matchedOn }
      : { visible: false as const, matchedOn };
  });
}
