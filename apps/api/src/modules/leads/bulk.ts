import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { canOnRecord, normalizePhone } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden } from "../../http/errors";
import { deleteLead, recordActivity, visibleLead } from "./service";
import { assignLead, moveStage } from "./write";

export type BulkAction =
  | { type: "stage"; stageId: string; lostReasonId?: string; lostNote?: string }
  | { type: "assign"; ownerId: string | null }
  | { type: "tags"; add?: string[]; remove?: string[] }
  | { type: "delete" }
  | { type: "set_phone_country"; country: string };

/**
 * Report §14 bulk actions. Every lead is checked on its own (scope, bulk_edit, the action's permission,
 * RLS); a refusal is reported and rolled back to a savepoint without disturbing the others.
 */
export async function runBulk(req: FastifyRequest, ids: string[], action: BulkAction) {
  const unique = [...new Set(ids)];
  if (action.type === "tags") {
    const all = [...(action.add ?? []), ...(action.remove ?? [])];
    if (!all.length) throw badRequest("NOTHING_TO_DO", "Add or remove at least one tag");
    const found = await req.db
      .select({ id: schema.tags.id })
      .from(schema.tags)
      .where(inArray(schema.tags.id, all));
    if (found.length !== new Set(all).size)
      throw badRequest("UNKNOWN_TAG", "One of those tags doesn't exist");
  }
  const updated: string[] = [];
  const skipped: { id: string; code: string }[] = [];
  for (const [i, id] of unique.entries()) {
    const sp = sql.raw(`bulk_${i}`);
    await req.db.execute(sql`SAVEPOINT ${sp}`);
    try {
      const lead = await visibleLead(req, id);
      if (!canOnRecord(req.actor!, "leads.bulk_edit", lead.ownerId)) throw forbidden();
      switch (action.type) {
        case "stage":
          await moveStage(req, lead, {
            stageId: action.stageId,
            lostReasonId: action.lostReasonId,
            ...(action.lostNote ? { lostNote: action.lostNote } : {}),
          });
          break;
        case "assign":
          await assignLead(req, lead, { ownerId: action.ownerId, reason: "bulk" });
          break;
        case "delete":
          await deleteLead(req, id);
          break;
        case "tags":
          if (!canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
          if (action.remove?.length)
            await req.db
              .delete(schema.leadTags)
              .where(and(eq(schema.leadTags.leadId, id), inArray(schema.leadTags.tagId, action.remove)));
          if (action.add?.length)
            await req.db
              .insert(schema.leadTags)
              .values(action.add.map((tagId) => ({ leadId: id, tagId })))
              .onConflictDoNothing();
          await req.db
            .update(schema.leads)
            .set({ version: sql`${schema.leads.version} + 1` })
            .where(eq(schema.leads.id, id));
          await recordActivity(req, id, "field_changed", { fields: ["tags"] });
          break;
        case "set_phone_country": {
          // Spec §10: the number as typed, read again with a country. Works on masked numbers too: the
          // digits never leave the server, and the history records only the country.
          if (!canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
          if (lead.phoneStatus === "valid")
            throw badRequest("ALREADY_VALID", "Already a number LUME can read");
          if (!lead.phoneRaw) throw badRequest("NO_NUMBER", "No number");
          const p = normalizePhone(lead.phoneRaw, action.country);
          if (p.status !== "valid") throw badRequest("STILL_INVALID", "Still not a number LUME can read");
          await req.db
            .update(schema.leads)
            .set({
              phoneE164: p.e164,
              phoneCountryIso: p.countryIso,
              phoneStatus: "valid",
              version: sql`${schema.leads.version} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(schema.leads.id, id));
          await recordActivity(req, id, "phone_country_set", { country: action.country });
          break;
        }
      }
      await req.db.execute(sql`RELEASE SAVEPOINT ${sp}`);
      updated.push(id);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err; // real failures still roll the whole request back
      await req.db.execute(sql`ROLLBACK TO SAVEPOINT ${sp}`);
      skipped.push({ id, code: err.code });
    }
  }
  await audit(req, {
    action: "lead.bulk",
    entityType: "lead",
    diff: { type: action.type, updated: updated.length, skipped: skipped.length },
  });
  return { updated, skipped };
}
