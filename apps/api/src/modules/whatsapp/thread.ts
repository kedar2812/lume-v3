import { schema } from "@lume/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { visibleLead } from "../leads/service";
import { whatsappOn } from "./service";

const A = schema.activities;
const THREAD_MAX = 500;
type Media = { id: string; kind: string; mime: string; filename: string | null; voice: boolean };

/**
 * A lead's WhatsApp thread for the drawer (spec 2026-10-18 §4.2): its messages, oldest first (the newest 500), each in
 * (from the lead) or out (from the business's phone), with its file when there is one; and whether WhatsApp is on.
 */
export async function leadThread(req: FastifyRequest, leadId: string) {
  const lead = await visibleLead(req, leadId);
  const rows = await req.db
    .select({ id: A.id, type: A.type, at: A.occurredAt, payload: A.payload })
    .from(A)
    .where(and(eq(A.leadId, lead.id), inArray(A.type, ["whatsapp_received", "whatsapp_sent"])))
    .orderBy(asc(A.occurredAt), asc(A.id))
    .limit(THREAD_MAX);
  return {
    on: await whatsappOn(req),
    messages: rows.map((r) => {
      const p = (r.payload ?? {}) as { text?: string | null; name?: string; media?: Partial<Media> };
      return {
        id: r.id,
        direction: r.type === "whatsapp_received" ? ("in" as const) : ("out" as const),
        at: r.at.toISOString(),
        text: p.text ?? null,
        media: p.media?.id
          ? {
              id: p.media.id,
              kind: p.media.kind ?? "document",
              mime: p.media.mime ?? "application/octet-stream",
              filename: p.media.filename ?? null,
              voice: p.media.voice ?? false,
            }
          : null,
      };
    }),
  };
}
