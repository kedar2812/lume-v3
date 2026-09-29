import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { mapRow, startOfDayUtc, type Issue, type LeadDraft, type Mapping, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import { loadFieldRegistry } from "../../leads/fields";
import { insertLead, mergeFill, mergeIntoLead } from "../leads/writer";
import { runOnEnter, type AutomationDeps } from "../tasks/automations";
import { contactProbes, findMatches, type FullMapContext } from "./context";

export type RowCounter =
  | "created"
  | "merged"
  | "skipped"
  | "empty"
  | "errors"
  | "warnings"
  | "name_from_contact"
  | "missing_stage_fields"
  | "phone_needs_country";
export type RowResult = {
  result: "created" | "merged" | "skipped" | "error";
  leadId: string | null;
  problems: Issue[];
  warnings: Issue[];
  alsoMatched: string[];
  /** The row as a lead, when it read as one (null for an empty row or one mapRow refused). */
  draft: LeadDraft | null;
  counters: Partial<Record<RowCounter, number>>;
};
export type RowInput = {
  sourceId: string;
  rules: Rules;
  mapping: Mapping;
  ctx: FullMapContext;
  cells: string[];
  /** Where the lead's history says it came from: { importId, file, row } or { sourceId, sheet, row }. */
  origin: Record<string, unknown>;
  /** The next turn in round-robin ownership, from a counter the caller's run keeps. */
  nextTurn: () => Promise<number>;
  /**
   * A sheet row that was still being typed when it was first read (2B final review, finding 6): fill in
   * the lead it made, whatever its contacts now match, and say so in its history with this activity.
   */
  mergeInto?: { leadId: string; activity: string };
  /**
   * Run the first stage's automations for a lead this row creates (3C): live intake (webhooks, a sheet's
   * syncs after its first) passes them; CSV imports and a sheet's first sync are history and don't.
   */
  automations?: AutomationDeps;
};

/** A transaction-scoped lock on one contact key (its first 64 bits), so two runs can't both create it. */
const lockContact = (hex: string) =>
  sql`SELECT pg_advisory_xact_lock(('x' || ${hex.slice(0, 16)})::bit(64)::bigint)`;
const warned = (w: Issue[]) => (w.length ? 1 : 0);

/**
 * Spec 2A §6.9–§6.10 for one row, inside the caller's transaction (every lead visible, acting as the
 * person the run belongs to): map → check → lock the contacts → match → create, merge or skip.
 */
export async function writeRow(req: FastifyRequest, o: RowInput): Promise<RowResult> {
  const { rules, mapping, ctx, cells } = o;
  const out = (
    result: RowResult["result"],
    f: Partial<Omit<RowResult, "result" | "counters">>,
    counters: RowResult["counters"],
  ): RowResult => ({
    result,
    leadId: f.leadId ?? null,
    problems: f.problems ?? [],
    warnings: f.warnings ?? [],
    alsoMatched: f.alsoMatched ?? [],
    draft: f.draft ?? null,
    counters,
  });

  const outcome = mapRow(cells, mapping, rules, ctx);
  if (outcome.kind === "empty")
    return out(
      "skipped",
      { problems: [{ column: null, code: "EMPTY_ROW", message: "Empty row" }] },
      { empty: 1 },
    );
  if (outcome.kind === "error")
    return out(
      "error",
      { problems: outcome.problems, warnings: outcome.warnings },
      { errors: 1, warnings: warned(outcome.warnings) },
    );

  const draft = outcome.draft;
  const warnings = [...outcome.warnings];
  // A safety net behind mapRow: the field registry's own create schema, exactly as a hand-made lead meets it.
  const custom = (await loadFieldRegistry(req)).custom.create.safeParse(draft.custom);
  if (!custom.success)
    return out(
      "error",
      {
        draft,
        warnings,
        problems: custom.error.issues.map((i) => ({
          column: null,
          code: "INVALID_FIELD",
          message: `${i.path.join(".")}: ${i.message}`,
        })),
      },
      { errors: 1, warnings: warned(warnings) },
    );
  const customData = custom.data as Record<string, unknown>;

  for (const p of contactProbes(draft, rules.matchOn).sort((a, b) => a.hash.localeCompare(b.hash)))
    await req.db.execute(lockContact(p.hash));
  const matches = rules.matchOn.length ? await findMatches(req, draft, rules.matchOn) : [];
  const contact = {
    phoneRaw: draft.phone.raw,
    phoneE164: draft.phone.e164,
    phoneCountryIso: draft.phone.countryIso,
    phoneStatus: draft.phone.status,
    email: draft.email,
    instagramHandle: draft.instagram,
  };
  const also = matches.slice(1).map((m) => m.leadId);

  const [forced] = o.mergeInto
    ? await req.db
        .select({ id: schema.leads.id })
        .from(schema.leads)
        .where(and(eq(schema.leads.id, o.mergeInto.leadId), isNull(schema.leads.deletedAt)))
    : [];
  if ((matches.length && rules.onMatch !== "duplicate") || forced) {
    const target = forced ? forced.id : matches[0]!.leadId;
    if (!forced && rules.onMatch === "skip")
      return out(
        "skipped",
        {
          draft,
          leadId: target,
          warnings,
          alsoMatched: also,
          problems: [
            { column: null, code: "MATCHED_SKIPPED", message: "Matches an existing lead; skipped." },
          ],
        },
        { skipped: 1, warnings: warned(warnings) },
      );
    const [lead] = await req.db.select().from(schema.leads).where(eq(schema.leads.id, target));
    const tagIds = (
      await req.db
        .select({ id: schema.leadTags.tagId })
        .from(schema.leadTags)
        .where(eq(schema.leadTags.leadId, target))
    ).map((t) => t.id);
    // A merge takes an owner only from the row's owner column; the owner rule is for leads it creates.
    const { fill, filled } = mergeFill(
      lead!,
      {
        contact,
        value: draft.value,
        leadCreatedAt: draft.leadCreatedAt,
        ownerId: draft.ownerId ?? null,
        custom: customData,
        tagIds: draft.tagIds,
      },
      tagIds,
      rules.reopenClosedTo,
    );
    await mergeIntoLead(req, lead!, fill, {
      type: forced ? o.mergeInto!.activity : "imported_again",
      payload: { ...o.origin, filled, extraPhones: draft.extraPhones, warnings: warnings.map((w) => w.code) },
    });
    return out(
      "merged",
      { draft, leadId: target, warnings, alsoMatched: also },
      { merged: 1, warnings: warned(warnings) },
    );
  }

  // Create: the owner from the row, else the owner rule (turn-taking in a fixed order: by name, then id).
  let ownerId: string | null = draft.ownerId ?? null;
  if (draft.ownerId === undefined) {
    if (rules.owner.mode === "user") {
      const chosen = rules.owner.userId;
      ownerId = ctx.people.find((p) => p.id === chosen && p.active)?.id ?? null;
      if (!ownerId)
        warnings.push({
          column: null,
          code: "OWNER_RULE_INACTIVE",
          message: "The chosen owner can't take leads now; left unassigned.",
        });
    } else if (rules.owner.mode === "round_robin") {
      const ids = rules.owner.userIds;
      const turns = ctx.people
        .filter((p) => p.active && ids.includes(p.id))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      if (!turns.length)
        warnings.push({
          column: null,
          code: "OWNER_RULE_INACTIVE",
          message: "Nobody chosen to take turns can take leads now; left unassigned.",
        });
      else ownerId = turns[(await o.nextTurn()) % turns.length]!.id;
    }
  }
  const stageId = draft.stageId ?? rules.stageId;
  const stage = ctx.stagesFull.find((s) => s.id === stageId);
  if (!stage)
    return out(
      "error",
      {
        draft,
        warnings,
        problems: [
          { column: null, code: "STAGE_GONE", message: "The stage for new leads no longer exists." },
        ],
      },
      { errors: 1, warnings: warned(warnings) },
    );
  // The lead's own date, when the row has one, is when it entered its stage (and closed, if closed).
  const origin = draft.leadCreatedAt ? startOfDayUtc(draft.leadCreatedAt, ctx.timezone) : null;
  const leadId = await insertLead(req, {
    pipelineId: rules.pipelineId,
    stageId,
    ownerId,
    name: draft.name,
    contact,
    value: draft.value,
    productId: null,
    leadCreatedAt: draft.leadCreatedAt,
    custom: customData,
    tagIds: draft.tagIds,
    sourceId: o.sourceId,
    lostReasonId: draft.lostReasonId,
    closedAt: stage.kind === "open" ? null : (origin ?? new Date()),
    stageKind: stage.kind,
    stageEnteredAt: origin ?? new Date(),
    activity: {
      type: "imported",
      payload: { ...o.origin, extraPhones: draft.extraPhones, warnings: warnings.map((w) => w.code) },
    },
    assignReason: "imported",
  });
  if (o.automations)
    await runOnEnter(req, { id: leadId, name: draft.name, ownerId }, stage, "created", {
      deps: o.automations,
      intake: true,
    });
  // A stage's required fields aren't enforced on import (2A spec §6.5), but the leads missing them are counted.
  const core: Record<string, unknown> = {
    name: draft.name,
    phone: draft.phone.raw,
    email: draft.email,
    instagram: draft.instagram,
    value: draft.value,
    lead_created_at: draft.leadCreatedAt,
    owner: ownerId,
    stage: stageId,
    source: o.sourceId,
  };
  const filledIds = new Set(
    ctx.fields
      .filter((f) => {
        const v = f.isCore ? core[f.key] : customData[f.key];
        return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length);
      })
      .map((f) => f.id),
  );
  const missing = stage.requiredFieldIds.some((id) => !filledIds.has(id));
  if (missing)
    warnings.push({
      column: null,
      code: "MISSING_STAGE_FIELDS",
      message: `${stage.name} asks for fields this lead doesn't have yet.`,
    });
  return out(
    "created",
    { draft, leadId, warnings, alsoMatched: also },
    {
      created: 1,
      warnings: warned(warnings),
      name_from_contact: draft.nameFromContact ? 1 : 0,
      phone_needs_country: draft.phone.status === "needs_country" ? 1 : 0,
      missing_stage_fields: missing ? 1 : 0,
    },
  );
}
