import { firstNameOf, trimHistory, type LeadFacts } from "@lume/core";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { loadFieldRegistry } from "../../leads/fields";
import { contextFor } from "../leads/sending";
import type { LeadRow } from "../leads/serialize";

const OUTCOMES: Record<string, string> = {
  talked: "Talked",
  no_answer: "No answer",
  left_message: "Left a message",
};

/** A field's value in words: an option's label, a list joined, a date or number as written. */
function words(v: unknown, options: { id: string; label: string }[]): string {
  const one = (x: unknown) => options.find((o) => o.id === x)?.label ?? String(x);
  return Array.isArray(v) ? v.map(one).join(", ") : one(v);
}

/**
 * What LUME AI may know about a lead (spec 2026-10-18 §5.4): its first name, the fields this person can see that
 * aren't contacts (`contextFor`'s rule, the same as a message template's), its stage among its pipeline's, the
 * business's lost reasons and tags, and its last notes, calls, stage moves and follow-ups. Never a phone, an email,
 * a web address or an Instagram handle.
 */
export async function leadFacts(req: FastifyRequest, d: AppDeps, lead: LeadRow): Promise<LeadFacts> {
  const ctx = await contextFor(req, lead);
  const labels = new Map((await loadFieldRegistry(req)).defs.map((f) => [f.key, f.label]));
  const stages = await req.db
    .select({ id: schema.stages.id, name: schema.stages.name, kind: schema.stages.kind })
    .from(schema.stages)
    .where(and(eq(schema.stages.pipelineId, lead.pipelineId), isNull(schema.stages.archivedAt)))
    .orderBy(asc(schema.stages.position));
  const lostReasons = await req.db
    .select({ id: schema.lostReasons.id, label: schema.lostReasons.label })
    .from(schema.lostReasons)
    .where(isNull(schema.lostReasons.archivedAt))
    .orderBy(asc(schema.lostReasons.position));
  const tags = await req.db.select({ id: schema.tags.id, label: schema.tags.label }).from(schema.tags);
  const acts = await req.db
    .select({
      type: schema.activities.type,
      payload: schema.activities.payload,
      at: schema.activities.occurredAt,
    })
    .from(schema.activities)
    .where(
      and(
        eq(schema.activities.leadId, lead.id),
        inArray(schema.activities.type, ["note", "call_logged", "stage_changed", "follow_up_set"]),
      ),
    )
    .orderBy(desc(schema.activities.occurredAt))
    .limit(40);
  const stageName = (id: unknown) => stages.find((s) => s.id === id)?.name ?? "another stage";
  const history: LeadFacts["history"] = acts
    .reverse()
    .map((a) => {
      const p = a.payload as Record<string, unknown>;
      const at = a.at.toISOString();
      switch (a.type) {
        case "note":
          return { at, kind: "note" as const, text: String(p.body ?? "") };
        case "call_logged":
          return {
            at,
            kind: "call" as const,
            text: [OUTCOMES[String(p.outcome)] ?? "Call", p.note ? String(p.note) : ""]
              .filter(Boolean)
              .join(": "),
          };
        case "stage_changed":
          return { at, kind: "stage" as const, text: `Moved to ${stageName(p.to)}` };
        default:
          return {
            at,
            kind: "follow_up" as const,
            text: `Follow-up set: ${String(p.title ?? "")} at ${String(p.dueAt ?? "")}`,
          };
      }
    })
    .filter((h) => h.text.trim());
  const current = stages.find((s) => s.id === lead.stageId);
  const fields = ctx.fields
    .filter((f) => ctx.lead.custom[f.key] !== undefined && ctx.lead.custom[f.key] !== null)
    .map((f) => ({
      label: labels.get(f.key) ?? f.key,
      value: words(ctx.lead.custom[f.key], f.options ?? []),
    }))
    .filter((f) => f.value.trim());
  return {
    // The record's name as this person may see it (empty when their role can't), past any title.
    firstName: firstNameOf(ctx.lead.name),
    stage: { id: lead.stageId, name: current?.name ?? "" },
    stages,
    lostReasons,
    tags,
    fields,
    history: trimHistory(history),
    timezone: ctx.business.timezone,
    now: d.clock().toISOString(),
  };
}

/** The words of a note or a logged call on this lead, or null (another lead's, another kind, or empty). */
export async function noteText(
  req: FastifyRequest,
  leadId: string,
  activityId: string,
): Promise<string | null> {
  const r = await req.db.execute<{ type: string; payload: Record<string, unknown> }>(
    sql`SELECT type, payload FROM activities WHERE id = ${activityId} AND lead_id = ${leadId}`,
  );
  const a = r.rows[0];
  if (!a) return null;
  const text = a.type === "note" ? a.payload.body : a.type === "call_logged" ? a.payload.note : null;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}
