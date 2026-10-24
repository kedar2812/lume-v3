import { schema } from "@lume/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { visibleLead } from "../leads/service";
import { replyState } from "./send";
import { whatsappOn } from "./service";

const A = schema.activities;
const O = schema.whatsappOutbox;
const THREAD_MAX = 500;
type Media = { id: string; kind: string; mime: string; filename: string | null; voice: boolean };
type Row = { id: string; type: string; at: Date; payload: unknown };
type Payload = {
  text?: string | null;
  outboxId?: string;
  media?: Partial<Media>;
  via?: string;
  runId?: string;
};

/** One message on a lead's thread: the lead's, one sent from the phone, or one sent from LUME (with its status). */
export type ThreadMessage = {
  id: string;
  direction: "in" | "out";
  at: string;
  text: string | null;
  media: Media | null;
  /** Sent from LUME (plan W3a): who, where it's got to, and why it failed. Null for the rest. */
  sentBy: { id: string; name: string } | null;
  status: "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | null;
  problem: string | null;
  outboxId: string | null;
  /** Written and sent by LUME AI for `sentBy`, in this run (Autopilot A2, spec 2026-10-19 §3); null for the rest. */
  lumeAi: { runId: string } | null;
};

/** The messages as the thread shows them: LUME's own sends joined to their status in one query (outcome 26). */
async function shape(req: FastifyRequest, rows: Row[]): Promise<ThreadMessage[]> {
  const payloads = rows.map((r) => (r.payload ?? {}) as Payload);
  const ids = payloads.map((p) => p.outboxId).filter((x): x is string => !!x);
  const sent = ids.length
    ? await req.db
        .select({ id: O.id, status: O.status, problem: O.problem, userId: O.userId, name: schema.users.name })
        .from(O)
        .leftJoin(schema.users, eq(schema.users.id, O.userId))
        .where(inArray(O.id, ids))
    : [];
  const byId = new Map(sent.map((s) => [s.id, s]));
  return rows.flatMap((r, i) => {
    const p = payloads[i]!;
    const o = p.outboxId ? byId.get(p.outboxId) : undefined;
    // LUME AI's, cancelled by a Pause before it went (Autopilot A2): never sent, so never shown as a message.
    if (!o || o.status !== "cancelled") return [shown(r, p, o)];
    return [];
  });
}

function shown(
  r: Row,
  p: Payload,
  o:
    | {
        id: string;
        status: ThreadMessage["status"] | "cancelled";
        problem: string | null;
        userId: string;
        name: string | null;
      }
    | undefined,
): ThreadMessage {
  return {
    id: r.id,
    direction: r.type === "whatsapp_received" ? "in" : "out",
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
    sentBy: o ? { id: o.userId, name: o.name ?? "Someone" } : null,
    status: o && o.status !== "cancelled" ? o.status : null,
    problem: o?.problem ?? null,
    outboxId: o?.id ?? null,
    lumeAi: p.via === "ai_autopilot" && p.runId ? { runId: p.runId } : null,
  };
}

/** These thread entries (activity ids), as the thread shows them. */
export async function messagesOf(req: FastifyRequest, activityIds: string[]): Promise<ThreadMessage[]> {
  if (!activityIds.length) return [];
  const rows = await req.db
    .select({ id: A.id, type: A.type, at: A.occurredAt, payload: A.payload })
    .from(A)
    .where(inArray(A.id, activityIds));
  return shape(req, rows);
}

/**
 * A lead's WhatsApp thread for the drawer (spec 2026-10-18 §4.2): its newest 500 messages, oldest first, each in (from
 * the lead) or out (from the business's phone, or from LUME with who sent it and its status), with its file when there
 * is one; whether WhatsApp is on; and whether this person may reply from LUME now (plan W3a).
 */
export async function leadThread(req: FastifyRequest, d: AppDeps, leadId: string) {
  const lead = await visibleLead(req, leadId);
  // The newest 500, then put oldest first: a long chat must never show its first 500 with today's hidden.
  const rows = (
    await req.db
      .select({ id: A.id, type: A.type, at: A.occurredAt, payload: A.payload })
      .from(A)
      .where(and(eq(A.leadId, lead.id), inArray(A.type, ["whatsapp_received", "whatsapp_sent"])))
      .orderBy(desc(A.occurredAt), desc(A.id))
      .limit(THREAD_MAX)
  ).reverse();
  return {
    on: await whatsappOn(req),
    reply: await replyState(req, d, lead),
    messages: await shape(req, rows),
  };
}
