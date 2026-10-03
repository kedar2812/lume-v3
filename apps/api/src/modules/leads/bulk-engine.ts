import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { can, canOnRecord, newId, normalizePhone, scopeOf } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { loadActor } from "../../rbac/actor";
import type { AppDeps } from "../../app";
import { serverHelpers } from "../../server-helpers";
import { jobServer, withJobRequest } from "../imports/job-request";
import { notify, type NewNotification } from "../notifications/notify";
import { cancelLeadTasks } from "../tasks/lifecycle";
import {
  limits,
  type BulkAction,
  type Item,
  type RunHooks,
  type RunRow,
  type UndoAction,
} from "./bulk-config";
import { tagsFor } from "./query";
import type { LeadRow } from "./serialize";
import { hasValue } from "./write";
import { loadFieldRegistry } from "../../leads/fields";
import { runOnEnter } from "../tasks/automations";

/**
 * Phase 7B: how a run's items are applied, a chunk at a time, in one transaction as the person.
 * - assign, tags, delete and set-phone-country are set-based: the eligible leads change in one statement, and their
 *   history and activities go in together;
 * - stage moves keep the per-lead path (stage history, won/lost stamps, the stage's automations).
 * Every lead is still checked on its own; one the person may not touch is skipped with its reason.
 */
const L = schema.leads;
const R = schema.bulkRuns;
const I = schema.bulkRunItems;
type Result = {
  lead_id: string;
  result: "done" | "skipped";
  code: string | null;
  before: unknown;
  after_version: number | null;
};
const skip = (lead_id: string, code: string): Result => ({
  lead_id,
  result: "skipped",
  code,
  before: null,
  after_version: null,
});
const uuids = (ids: string[]) => `{${ids.join(",")}}`;

/** What the action is about to change, as it is now: what undo would put back. */
function beforeOf(action: BulkAction, lead: LeadRow, tagIds: string[]): Record<string, unknown> {
  switch (action.type) {
    case "assign":
      return { ownerId: lead.ownerId };
    case "stage":
      return {
        stageId: lead.stageId,
        pipelineId: lead.pipelineId,
        lostReasonId: lead.lostReasonId,
        lostNote: lead.lostNote,
        wonAt: lead.wonAt,
        lostAt: lead.lostAt,
      };
    case "tags":
      return { tagIds };
    case "delete":
      return { deletedAt: null };
    case "set_phone_country":
      return {
        phoneE164: lead.phoneE164,
        phoneCountryIso: lead.phoneCountryIso,
        phoneStatus: lead.phoneStatus,
      };
  }
}

/**
 * Stage moves, a chunk at a time, with everything a single move does (moveStage): the stage and lost reason
 * checked, required fields per lead, won/lost stamps, stage history, "reopened" and "stage changed" activities,
 * and the stage's automations for each lead that moved. The lookups are made once a chunk and the writes go
 * together; only the automations (when the stage has any) still run lead by lead. No per-lead audit: the run
 * keeps one entry.
 */
async function stageMany(
  req: FastifyRequest,
  action: Extract<BulkAction, { type: "stage" }>,
  items: Item[],
  hooks: RunHooks | undefined,
  n: number,
) {
  const actor = req.actor!;
  const ids = uuids(items.map((i) => i.leadId));
  const leads = await req.db
    .select()
    .from(L)
    .where(and(sql`${L.id} = ANY(${ids}::uuid[])`, isNull(L.deletedAt)))
    .for("update");
  const byId = new Map(leads.map((l) => [l.id, l]));
  const [target] = await req.db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.id, action.stageId), isNull(schema.stages.archivedAt)));
  const kinds = new Map(
    (await req.db.select({ id: schema.stages.id, kind: schema.stages.kind }).from(schema.stages)).map((x) => [
      x.id,
      x.kind,
    ]),
  );
  let reasonOk = true;
  if (target?.kind === "lost" && action.lostReasonId) {
    const [reason] = await req.db
      .select({ id: schema.lostReasons.id })
      .from(schema.lostReasons)
      .where(and(eq(schema.lostReasons.id, action.lostReasonId), isNull(schema.lostReasons.archivedAt)));
    reasonOk = !!reason;
  }
  const fields = target?.requiredFieldIds.length ? await loadFieldRegistry(req) : null;
  const required = (fields ? target!.requiredFieldIds.map((id) => fields.byId.get(id)) : []).filter(
    (d): d is NonNullable<typeof d> => !!d && !d.archived,
  );
  const out = new Map<string, Result>();
  const move: LeadRow[] = [];
  for (const [i, item] of items.entries()) {
    await hooks?.midChunk?.(n, i);
    const lead = byId.get(item.leadId);
    if (!lead) {
      out.set(item.leadId, skip(item.leadId, "LEAD_NOT_FOUND"));
      continue;
    }
    const code = !canOnRecord(actor, "leads.bulk_edit", lead.ownerId)
      ? "FORBIDDEN"
      : !canOnRecord(actor, "leads.change_stage", lead.ownerId)
        ? "FORBIDDEN"
        : !target
          ? "UNKNOWN_STAGE"
          : null;
    if (code) {
      out.set(lead.id, skip(lead.id, code));
      continue;
    }
    const before = beforeOf(action, lead, []);
    // Already there (and not a lost move, which records its reason again): done, nothing to change.
    if (target!.id === lead.stageId && target!.kind !== "lost") {
      out.set(lead.id, { lead_id: lead.id, result: "done", code: null, before, after_version: lead.version });
      continue;
    }
    if (required.some((d) => !hasValue(lead, d.key))) {
      out.set(lead.id, skip(lead.id, "REQUIRED_FIELDS"));
      continue;
    }
    if (target!.kind === "lost" && !action.lostReasonId) {
      out.set(lead.id, skip(lead.id, "LOST_REASON_REQUIRED"));
      continue;
    }
    if (!reasonOk) {
      out.set(lead.id, skip(lead.id, "UNKNOWN_LOST_REASON"));
      continue;
    }
    out.set(lead.id, { lead_id: lead.id, result: "done", code: null, before, after_version: lead.version });
    move.push(lead);
  }
  if (move.length && target) {
    const moving = uuids(move.map((l) => l.id));
    const stamps =
      target.kind === "lost"
        ? sql`lost_at = now(), won_at = NULL, lost_reason_id = ${action.lostReasonId!}, lost_note = ${action.lostNote ?? null}`
        : target.kind === "won"
          ? sql`won_at = now(), lost_at = NULL, lost_reason_id = NULL, lost_note = NULL`
          : sql`won_at = NULL, lost_at = NULL, lost_reason_id = NULL, lost_note = NULL`;
    await req.db.insert(schema.leadStageHistory).values(
      move.map((l) => ({
        leadId: l.id,
        fromStageId: l.stageId,
        toStageId: target.id,
        pipelineId: target.pipelineId,
        changedBy: actor.userId,
      })),
    );
    // A lost lead back in an open stage is reopened (4A; report §11.3), for "lost → reopened → won".
    await activities(
      req,
      move
        .filter((l) => kinds.get(l.stageId) === "lost" && target.kind === "open")
        .map((l) => ({ leadId: l.id, type: "reopened", payload: { from: l.stageId, to: target.id } })),
    );
    await activities(
      req,
      move.map((l) => ({
        leadId: l.id,
        type: "stage_changed",
        payload: {
          from: l.stageId,
          to: target.id,
          ...(target.kind === "lost" && action.lostReasonId ? { lostReasonId: action.lostReasonId } : {}),
        },
      })),
    );
    const versions = (
      await req.db.execute<{ id: string; version: number }>(sql`
        UPDATE leads SET stage_id = ${target.id}, pipeline_id = ${target.pipelineId}, stage_entered_at = now(),
               last_activity_at = now(), ${stamps}, version = version + 1
         WHERE id = ANY(${moving}::uuid[]) RETURNING id, version`)
    ).rows;
    for (const v of versions) out.get(v.id)!.after_version = Number(v.version);
    // What the stage does when a lead enters it (3C), lead by lead, only when the stage has rules.
    for (const l of move)
      await runOnEnter(req, { id: l.id, name: l.name, ownerId: l.ownerId }, target, "moved");
  }
  return items.map((i) => out.get(i.leadId)!);
}

/** Whether this person may do this action to this lead, and if not, why (the codes single edits answer). */
function refusal(
  req: FastifyRequest,
  action: BulkAction,
  lead: LeadRow,
  country?: { status: string },
): string | null {
  const actor = req.actor!;
  if (!canOnRecord(actor, "leads.bulk_edit", lead.ownerId)) return "FORBIDDEN";
  switch (action.type) {
    case "assign":
      if (!canOnRecord(actor, "leads.assign", lead.ownerId)) return "FORBIDDEN";
      if (
        action.ownerId === null &&
        lead.ownerId !== null &&
        !actor.isOwner &&
        scopeOf(actor, "leads.assign") !== "all"
      )
        return "ASSIGN_OUT_OF_SCOPE";
      return null;
    case "delete":
      return canOnRecord(actor, "leads.delete", lead.ownerId) ? null : "FORBIDDEN";
    case "tags":
      return canOnRecord(actor, "leads.edit", lead.ownerId) ? null : "FORBIDDEN";
    case "set_phone_country":
      if (!canOnRecord(actor, "leads.edit", lead.ownerId)) return "FORBIDDEN";
      if (lead.phoneStatus === "valid") return "ALREADY_VALID";
      if (!lead.phoneRaw) return "NO_NUMBER";
      return country?.status === "valid" ? null : "STILL_INVALID";
    default:
      return null;
  }
}

async function activities(
  req: FastifyRequest,
  rows: { leadId: string; type: string; payload: Record<string, unknown> }[],
) {
  if (!rows.length) return;
  await req.db
    .insert(schema.activities)
    .values(rows.map((r) => ({ id: newId(), userId: req.actor!.userId, ...r })));
}

/** assign, tags, delete, set-phone-country: the chunk's leads are locked and read as the person, then changed together. */
async function setBased(
  req: FastifyRequest,
  action: Exclude<BulkAction, { type: "stage" }>,
  items: Item[],
  hooks: RunHooks | undefined,
  n: number,
) {
  const ids = items.map((i) => i.leadId);
  // Read as the person (their row-level security): a lead missing here is deleted or not theirs to see.
  const leads = await req.db
    .select()
    .from(L)
    .where(and(sql`${L.id} = ANY(${uuids(ids)}::uuid[])`, isNull(L.deletedAt)))
    .for("update");
  const byId = new Map(leads.map((l) => [l.id, l]));
  const tagsOf =
    action.type === "tags"
      ? await tagsFor(
          req,
          leads.map((l) => l.id),
        )
      : new Map<string, string[]>();
  const out = new Map<string, Result>();
  const change: LeadRow[] = [];
  const phones = new Map<string, { e164: string; iso: string }>();
  for (const [i, item] of items.entries()) {
    await hooks?.midChunk?.(n, i);
    const lead = byId.get(item.leadId);
    if (!lead) {
      out.set(item.leadId, skip(item.leadId, "LEAD_NOT_FOUND"));
      continue;
    }
    const p =
      action.type === "set_phone_country" && lead.phoneRaw
        ? normalizePhone(lead.phoneRaw, action.country)
        : undefined;
    const no = refusal(req, action, lead, p);
    if (no) {
      out.set(lead.id, skip(lead.id, no));
      continue;
    }
    const before = beforeOf(action, lead, tagsOf.get(lead.id) ?? []);
    out.set(lead.id, { lead_id: lead.id, result: "done", code: null, before, after_version: lead.version });
    // An owner that's already the owner is done with nothing to change, as a single assign answers.
    if (action.type === "assign" && action.ownerId === lead.ownerId) continue;
    if (p?.status === "valid") phones.set(lead.id, { e164: p.e164!, iso: p.countryIso! });
    change.push(lead);
  }
  if (change.length) {
    const changing = uuids(change.map((l) => l.id));
    let versions: { id: string; version: number }[] = [];
    switch (action.type) {
      case "assign": {
        // History first (it records from whom), then the owner, as LUME, for exactly these checked leads: the new
        // owner may be outside the person's scope (the many-lead form of the hand-off in assignLead).
        await req.db.insert(schema.leadAssignmentHistory).values(
          change.map((l) => ({
            leadId: l.id,
            fromUserId: l.ownerId,
            toUserId: action.ownerId,
            changedBy: req.actor!.userId,
            reason: "bulk",
          })),
        );
        await activities(
          req,
          change.map((l) => ({
            leadId: l.id,
            type: "assigned",
            payload: { from: l.ownerId, to: action.ownerId },
          })),
        );
        const [{ scope }] = (
          await req.db.execute<{ scope: string }>(
            sql`SELECT current_setting('lume.lead_scope', true) AS scope`,
          )
        ).rows as [{ scope: string }];
        await req.db.execute(sql`SELECT set_config('lume.lead_scope', 'all', true)`);
        versions = (
          await req.db.execute<{ id: string; version: number }>(sql`
          UPDATE leads SET owner_id = ${action.ownerId}, last_activity_at = now(), version = version + 1
           WHERE id = ANY(${changing}::uuid[]) RETURNING id, version`)
        ).rows;
        await req.db.execute(sql`SELECT set_config('lume.lead_scope', ${scope ?? ""}, true)`);
        break;
      }
      case "tags":
        if (action.remove?.length)
          await req.db.execute(
            sql`DELETE FROM lead_tags WHERE lead_id = ANY(${changing}::uuid[]) AND tag_id = ANY(${uuids(action.remove)}::uuid[])`,
          );
        if (action.add?.length)
          await req.db.execute(sql`
            INSERT INTO lead_tags (lead_id, tag_id)
            SELECT l, t FROM unnest(${changing}::uuid[]) l, unnest(${uuids(action.add)}::uuid[]) t ON CONFLICT DO NOTHING`);
        versions = (
          await req.db.execute<{ id: string; version: number }>(sql`
          UPDATE leads SET version = version + 1 WHERE id = ANY(${changing}::uuid[]) RETURNING id, version`)
        ).rows;
        await activities(
          req,
          change.map((l) => ({ leadId: l.id, type: "field_changed", payload: { fields: ["tags"] } })),
        );
        break;
      case "delete": {
        versions = (
          await req.db.execute<{ id: string; version: number }>(sql`
          UPDATE leads SET deleted_at = now(), version = version + 1 WHERE id = ANY(${changing}::uuid[]) RETURNING id, version`)
        ).rows;
        // Their follow-ups stop with them (Phase 3 spec §3): only the leads that have any open.
        const withTasks = await req.db.execute<{ lead_id: string }>(
          sql`SELECT DISTINCT lead_id FROM tasks WHERE lead_id = ANY(${changing}::uuid[]) AND status = 'open'`,
        );
        for (const t of withTasks.rows) await cancelLeadTasks(req, t.lead_id);
        break;
      }
      case "set_phone_country": {
        const list = change.map((l) => ({ id: l.id, ...phones.get(l.id)! }));
        versions = (
          await req.db.execute<{ id: string; version: number }>(sql`
          UPDATE leads l SET phone_e164 = v.e164, phone_country_iso = v.iso, phone_status = 'valid',
                 version = l.version + 1, updated_at = now()
            FROM jsonb_to_recordset(${JSON.stringify(list)}::jsonb) AS v(id uuid, e164 text, iso text)
           WHERE l.id = v.id RETURNING l.id, l.version`)
        ).rows;
        // Spec §10: the history records only the country, never a digit.
        await activities(
          req,
          change.map((l) => ({
            leadId: l.id,
            type: "phone_country_set",
            payload: { country: action.country },
          })),
        );
        break;
      }
    }
    for (const v of versions) out.get(v.id)!.after_version = Number(v.version);
  }
  return items.map((i) => out.get(i.leadId)!);
}

/** Whether this person may put this lead back: the permissions the original action needed. */
function mayRestore(
  req: FastifyRequest,
  kind: BulkAction["type"],
  lead: LeadRow,
  before: Record<string, unknown>,
) {
  const actor = req.actor!;
  if (!canOnRecord(actor, "leads.bulk_edit", lead.ownerId)) return "FORBIDDEN";
  const key = (
    {
      assign: "leads.assign",
      stage: "leads.change_stage",
      tags: "leads.edit",
      delete: "leads.delete",
      set_phone_country: "leads.edit",
    } as const
  )[kind];
  if (!canOnRecord(actor, key, lead.ownerId)) return "FORBIDDEN";
  if (
    kind === "assign" &&
    before.ownerId === null &&
    !actor.isOwner &&
    scopeOf(actor, "leads.assign") !== "all"
  )
    return "ASSIGN_OUT_OF_SCOPE";
  return null;
}

/**
 * An undo's chunk: each lead goes back to what the run found, only if nobody has changed it since (its version is
 * still the one the run left); otherwise it's skipped as CHANGED_SINCE and keeps the newer change. A stage goes back
 * directly (with a history row): the stage's automations aren't run again, and what they did stays done.
 */
async function undoChunk(
  req: FastifyRequest,
  run: RunRow,
  action: UndoAction,
  items: Item[],
  hooks: RunHooks | undefined,
  n: number,
) {
  const kind = action.of;
  const ids = uuids(items.map((i) => i.leadId));
  const orig = new Map(
    (
      await req.db
        .select({ leadId: I.leadId, before: I.before, afterVersion: I.afterVersion })
        .from(I)
        .where(and(eq(I.runId, run.undoOf!), sql`${I.leadId} = ANY(${ids}::uuid[])`))
    ).map((r) => [r.leadId, r]),
  );
  // Deleted leads too: undoing a delete brings them back. Read as the person, locked.
  const leads = await req.db
    .select()
    .from(L)
    .where(sql`${L.id} = ANY(${ids}::uuid[])`)
    .for("update");
  const byId = new Map(leads.map((l) => [l.id, l]));
  const tagsNow =
    kind === "tags"
      ? await tagsFor(
          req,
          leads.map((l) => l.id),
        )
      : new Map<string, string[]>();
  const out = new Map<string, Result>();
  const back: { lead: LeadRow; to: Record<string, unknown> }[] = [];
  for (const [i, item] of items.entries()) {
    await hooks?.midChunk?.(n, i);
    const lead = byId.get(item.leadId);
    const o = orig.get(item.leadId);
    if (!lead) {
      out.set(item.leadId, skip(item.leadId, "LEAD_NOT_FOUND"));
      continue;
    }
    if (!o?.before || lead.version !== o.afterVersion) {
      out.set(lead.id, skip(lead.id, "CHANGED_SINCE"));
      continue;
    }
    const to = o.before;
    const no = mayRestore(req, kind, lead, to);
    if (no) {
      out.set(lead.id, skip(lead.id, no));
      continue;
    }
    const now =
      kind === "delete"
        ? { deletedAt: lead.deletedAt }
        : beforeOf({ type: kind } as BulkAction, lead, tagsNow.get(lead.id) ?? []);
    out.set(lead.id, {
      lead_id: lead.id,
      result: "done",
      code: null,
      before: now,
      after_version: lead.version,
    });
    back.push({ lead, to });
  }
  if (back.length) {
    const changing = uuids(back.map((b) => b.lead.id));
    const rows = (f: (b: (typeof back)[number]) => Record<string, unknown>) =>
      JSON.stringify(back.map((b) => ({ id: b.lead.id, ...f(b) })));
    let versions: { id: string; version: number }[] = [];
    switch (kind) {
      case "assign": {
        await req.db.insert(schema.leadAssignmentHistory).values(
          back.map((b) => ({
            leadId: b.lead.id,
            fromUserId: b.lead.ownerId,
            toUserId: (b.to.ownerId as string | null) ?? null,
            changedBy: req.actor!.userId,
            reason: "undo",
          })),
        );
        await activities(
          req,
          back.map((b) => ({
            leadId: b.lead.id,
            type: "assigned",
            payload: { from: b.lead.ownerId, to: b.to.ownerId ?? null, undo: true },
          })),
        );
        const scope = (
          await req.db.execute<{ scope: string | null }>(
            sql`SELECT current_setting('lume.lead_scope', true) AS scope`,
          )
        ).rows[0]?.scope;
        await req.db.execute(sql`SELECT set_config('lume.lead_scope', 'all', true)`);
        versions = (
          await req.db.execute<{ id: string; version: number }>(sql`
          UPDATE leads l SET owner_id = v.owner, last_activity_at = now(), version = l.version + 1
            FROM jsonb_to_recordset(${rows((b) => ({ owner: b.to.ownerId ?? null }))}::jsonb) AS v(id uuid, owner uuid)
           WHERE l.id = v.id RETURNING l.id, l.version`)
        ).rows;
        await req.db.execute(sql`SELECT set_config('lume.lead_scope', ${scope ?? ""}, true)`);
        break;
      }
      case "stage":
        versions = (
          await req.db.execute<{ id: string; version: number }>(sql`
          UPDATE leads l SET stage_id = v.stage, pipeline_id = coalesce(v.pipeline, l.pipeline_id),
                 lost_reason_id = v.reason, lost_note = v.note, won_at = v.won, lost_at = v.lost,
                 stage_entered_at = now(), version = l.version + 1
            FROM jsonb_to_recordset(${rows((b) => ({
              stage: b.to.stageId,
              pipeline: b.to.pipelineId ?? null,
              reason: b.to.lostReasonId ?? null,
              note: b.to.lostNote ?? null,
              won: b.to.wonAt ?? null,
              lost: b.to.lostAt ?? null,
            }))}::jsonb)
                 AS v(id uuid, stage uuid, pipeline uuid, reason uuid, note text, won timestamptz, lost timestamptz)
           WHERE l.id = v.id RETURNING l.id, l.version`)
        ).rows;
        await req.db.insert(schema.leadStageHistory).values(
          back.map((b) => ({
            leadId: b.lead.id,
            fromStageId: b.lead.stageId,
            toStageId: b.to.stageId as string,
            pipelineId: (b.to.pipelineId as string | undefined) ?? b.lead.pipelineId,
            changedBy: req.actor!.userId,
          })),
        );
        await activities(
          req,
          back.map((b) => ({
            leadId: b.lead.id,
            type: "stage_changed",
            payload: { from: b.lead.stageId, to: b.to.stageId, undo: true },
          })),
        );
        break;
      case "tags": {
        await req.db.execute(sql`DELETE FROM lead_tags WHERE lead_id = ANY(${changing}::uuid[])`);
        const pairs = back.flatMap((b) =>
          ((b.to.tagIds as string[] | undefined) ?? []).map((t) => ({ lead: b.lead.id, tag: t })),
        );
        // A tag deleted since isn't brought back.
        if (pairs.length)
          await req.db.execute(sql`
            INSERT INTO lead_tags (lead_id, tag_id)
            SELECT p.lead, p.tag FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS p(lead uuid, tag uuid)
              JOIN tags t ON t.id = p.tag ON CONFLICT DO NOTHING`);
        versions = (
          await req.db.execute<{ id: string; version: number }>(sql`
          UPDATE leads SET version = version + 1 WHERE id = ANY(${changing}::uuid[]) RETURNING id, version`)
        ).rows;
        await activities(
          req,
          back.map((b) => ({
            leadId: b.lead.id,
            type: "field_changed",
            payload: { fields: ["tags"], undo: true },
          })),
        );
        break;
      }
      case "delete":
        // The lead comes back; follow-ups cancelled with it stay cancelled.
        versions = (
          await req.db.execute<{ id: string; version: number }>(sql`
          UPDATE leads SET deleted_at = NULL, version = version + 1 WHERE id = ANY(${changing}::uuid[]) RETURNING id, version`)
        ).rows;
        break;
      case "set_phone_country":
        versions = (
          await req.db.execute<{ id: string; version: number }>(sql`
          UPDATE leads l SET phone_e164 = v.e164, phone_country_iso = v.iso, phone_status = v.status,
                 version = l.version + 1, updated_at = now()
            FROM jsonb_to_recordset(${rows((b) => ({
              e164: b.to.phoneE164 ?? null,
              iso: b.to.phoneCountryIso ?? null,
              status: b.to.phoneStatus,
            }))}::jsonb) AS v(id uuid, e164 text, iso text, status text)
           WHERE l.id = v.id RETURNING l.id, l.version`)
        ).rows;
        await activities(
          req,
          back.map((b) => ({
            leadId: b.lead.id,
            type: "field_changed",
            payload: { fields: ["phone"], undo: true },
          })),
        );
        break;
    }
    for (const v of versions) out.get(v.id)!.after_version = Number(v.version);
  }
  return items.map((i) => out.get(i.leadId)!);
}

/** Some of a run's items, in one transaction as the person; their results and the run's counts with them. */
export async function applyItems(req: FastifyRequest, run: RunRow, items: Item[], hooks?: RunHooks, n = 0) {
  const action = run.action as BulkAction | UndoAction;
  const results =
    action.type === "undo"
      ? await undoChunk(req, run, action, items, hooks, n)
      : action.type === "stage"
        ? await stageMany(req, action, items, hooks, n)
        : await setBased(req, action, items, hooks, n);
  await req.db.execute(sql`
    UPDATE bulk_run_items i SET result = r.result, code = r.code, before = r.before, after_version = r.after_version
      FROM jsonb_to_recordset(${JSON.stringify(results)}::jsonb)
           AS r(lead_id uuid, result text, code text, before jsonb, after_version int)
     WHERE i.run_id = ${run.id} AND i.lead_id = r.lead_id`);
  const skippedBy: Record<string, number> = {};
  for (const r of results) if (r.code) skippedBy[r.code] = (skippedBy[r.code] ?? 0) + 1;
  await countInto(req.db, run.id, results.filter((r) => r.result === "done").length, skippedBy);
}

/** Add to a run's counts; its reasons merge key by key. */
async function countInto(
  db: FastifyRequest["db"],
  runId: string,
  done: number,
  skippedBy: Record<string, number>,
) {
  const skipped = Object.values(skippedBy).reduce((a, b) => a + b, 0);
  await db.execute(sql`
    UPDATE bulk_runs SET done = done + ${done}, skipped = skipped + ${skipped},
      skipped_by = coalesce((SELECT jsonb_object_agg(key, total) FROM (
          SELECT key, sum(value::int) AS total FROM (
            SELECT * FROM jsonb_each_text(skipped_by) UNION ALL SELECT * FROM jsonb_each_text(${JSON.stringify(skippedBy)}::jsonb)
          ) x GROUP BY key) y), '{}'::jsonb)
     WHERE id = ${runId}`);
}

/** The end of a run: its status, and one audit entry for the whole of it (never one per lead). */
export async function finishRun(req: FastifyRequest, id: string, status: "done" | "cancelled", now: Date) {
  const [row] = await req.db.update(R).set({ status, finishedAt: now }).where(eq(R.id, id)).returning();
  // An undo, however it ends, closes the run it undid: a run is undone once.
  if (row!.undoOf) await req.db.update(R).set({ status: "undone" }).where(eq(R.id, row!.undoOf));
  await audit(req, { action: "lead.bulk", entityType: "lead", diff: auditDiff(row!) });
  return row!;
}

function auditDiff(row: RunRow) {
  return {
    type: (row.action as BulkAction).type,
    run: row.id,
    status: row.status,
    total: row.total,
    updated: row.done,
    skipped: row.skipped,
    selection: (row.selection as { kind: string }).kind,
  };
}

type Send = (userId: string, n: NewNotification) => Promise<unknown>;
const firstName = (full: string | null | undefined) => (full ?? "").trim().split(/\s+/)[0] || "someone";

/**
 * A run's notices, once it has committed: one to each new owner of an assign (never one per lead), and, for a
 * queued run, one to its maker. A run answered in the request needs no notice of its own.
 */
export async function runNotices(db: FastifyRequest["db"], row: RunRow, send: Send, o: { maker: boolean }) {
  const action = row.action as BulkAction | UndoAction;
  if (action.type === "undo") {
    if (!o.maker) return;
    const changed = (row.skippedBy as Record<string, number>).CHANGED_SINCE ?? 0;
    const back = row.done.toLocaleString("en-US");
    const kept = changed
      ? ` ${changed.toLocaleString("en-US")} had changed since, so LUME kept the newer change.`
      : "";
    await send(row.userId, {
      kind: "bulk_done",
      title: `LUME put back ${back} ${row.done === 1 ? "lead" : "leads"}.${kept}`,
      data: { run: row.id },
    });
    return;
  }
  const names = async (ids: string[]) =>
    new Map(
      (
        await db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(sql`${schema.users.id} = ANY(${uuids(ids)}::uuid[])`)
      ).map((u) => [u.id, u.name]),
    );
  const who = await names([
    row.userId,
    ...(action.type === "assign" && action.ownerId ? [action.ownerId] : []),
  ]);
  if (action.type === "assign" && action.ownerId && action.ownerId !== row.userId) {
    const moved = (
      await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM bulk_run_items
       WHERE run_id = ${row.id} AND result = 'done' AND (before->>'ownerId') IS DISTINCT FROM ${action.ownerId}`)
    ).rows[0]!.n;
    // One lead reads as a single hand-off does ("Noor Rahman was assigned to you by Maya"), when its name is visible.
    const one =
      moved === 1
        ? (
            await db.execute<{ id: string; name: string }>(sql`
            SELECT l.id, l.name FROM bulk_run_items i JOIN leads l ON l.id = i.lead_id
             WHERE i.run_id = ${row.id} AND i.result = 'done' AND (i.before->>'ownerId') IS DISTINCT FROM ${action.ownerId}`)
          ).rows[0]
        : undefined;
    const by = firstName(who.get(row.userId));
    if (moved > 0)
      await send(action.ownerId, {
        kind: "lead_assigned",
        title: one
          ? `${one.name} was assigned to you by ${by}`
          : `${moved.toLocaleString("en-US")} ${moved === 1 ? "lead was" : "leads were"} assigned to you by ${by}`,
        leadId: one?.id ?? null,
        data: { run: row.id },
      });
  }
  if (!o.maker) return;
  await send(row.userId, { kind: "bulk_done", title: await doneTitle(db, row, who), data: { run: row.id } });
}

/** "LUME moved 12,408 leads to Contacted. 12 were skipped." */
async function doneTitle(db: FastifyRequest["db"], row: RunRow, who: Map<string, string>) {
  const a = row.action as BulkAction;
  const n = row.done.toLocaleString("en-US");
  const leads = row.done === 1 ? "lead" : "leads";
  let what: string;
  if (row.status === "cancelled") what = `LUME stopped the bulk action, as asked, after ${n} ${leads}`;
  else if (a.type === "assign")
    what = a.ownerId
      ? `LUME assigned ${n} ${leads} to ${who.get(a.ownerId) ?? "someone"}`
      : `LUME unassigned ${n} ${leads}`;
  else if (a.type === "stage") {
    const [st] = await db
      .select({ name: schema.stages.name })
      .from(schema.stages)
      .where(eq(schema.stages.id, a.stageId));
    what = `LUME moved ${n} ${leads} to ${st?.name ?? "a stage"}`;
  } else if (a.type === "tags") what = `LUME changed the tags on ${n} ${leads}`;
  else if (a.type === "delete") what = `LUME deleted ${n} ${leads}`;
  else what = `LUME read ${n} ${row.done === 1 ? "number" : "numbers"} with the country ${a.country}`;
  const skipped = row.skipped - ((row.skippedBy as Record<string, number>).CANCELLED ?? 0);
  return `${what}.${skipped > 0 ? ` ${skipped.toLocaleString("en-US")} ${skipped === 1 ? "was" : "were"} skipped.` : ""}`;
}

/** What a queued run needs: the app, a pool of its own, and the clock (tests move it). */
export type RunDeps = { app: FastifyInstance; pool: pg.Pool; clock?: () => Date; tasks?: AppDeps["tasks"] };

/**
 * A queued run, chunk by chunk (the bulk queue's job). Only pending items are taken, so a run picked up again after
 * a crash carries on from the last committed chunk and never does one twice. Before each chunk: a cancel stops it,
 * and the maker's access is read afresh (disabled, paused, or no longer allowed to bulk edit ends it as failed).
 */
export async function processRun(o: RunDeps, runId: string, hooks?: RunHooks): Promise<void> {
  // A job's server carrying what the signed-in scope has: a stage's own rules run on the move, and whoever a
  // follow-up goes to is told, as a person's change would (as the Calendly job does).
  const app = Object.assign(
    Object.create(jobServer(o.app)) as FastifyInstance,
    serverHelpers({ pool: o.pool, tasks: o.tasks }),
  );
  const db = drizzle(o.pool, { schema });
  const now = () => (o.clock ? o.clock() : new Date());
  const [claimed] = await db
    .update(R)
    .set({
      status: "running",
      startedAt: sql`coalesce(${R.startedAt}, ${now()})`,
      attempts: sql`${R.attempts} + 1`,
    })
    .where(and(eq(R.id, runId), sql`${R.status} IN ('queued', 'running')`))
    .returning();
  if (!claimed) return;
  const send: Send = (u, n) => notify(o.pool, u, n);
  try {
    for (let n = 0; ; n++) {
      const actor = await loadActor(o.pool, claimed.userId);
      if (!actor || !can(actor, "leads.bulk_edit"))
        return await fail(o.pool, db, claimed, "Their access changed", now(), send);
      const [state] = await db.select({ cancel: R.cancelRequested }).from(R).where(eq(R.id, runId));
      // The end of a run is worked out in its last transaction (as the person), and told after it commits.
      const notices: [string, NewNotification][] = [];
      const collect: Send = async (u, x) => void notices.push([u, x]);
      const finished = await withJobRequest(
        { app, pool: o.pool, actor, requestId: `bulk:${runId}:${n}`, allLeads: false },
        async (req) => {
          const end = async (status: "done" | "cancelled") => {
            const row = await finishRun(req, runId, status, now());
            await runNotices(req.db, row, collect, { maker: true });
            return row;
          };
          if (state?.cancel) {
            const left = await req.db
              .update(I)
              .set({ result: "skipped", code: "CANCELLED" })
              .where(and(eq(I.runId, runId), eq(I.result, "pending")))
              .returning({ id: I.leadId });
            await countInto(req.db, runId, 0, left.length ? { CANCELLED: left.length } : {});
            return end("cancelled");
          }
          const items = await req.db
            .select({ leadId: I.leadId, position: I.position })
            .from(I)
            .where(and(eq(I.runId, runId), eq(I.result, "pending")))
            .orderBy(asc(I.position))
            .limit(limits.chunk);
          if (!items.length) return end("done");
          await applyItems(req, claimed, items, hooks, n);
          return null;
        },
      );
      if (finished) {
        for (const [u, x] of notices) await send(u, x).catch(() => undefined);
        return;
      }
      await hooks?.afterChunk?.(n);
    }
  } catch (e) {
    if (hooks && String(e).includes("test crash")) throw e;
    // pg-boss tries again (with backoff); the last try ends the run as failed, its done chunks kept.
    if (claimed.attempts < limits.attempts) throw e;
    await fail(
      o.pool,
      db,
      claimed,
      `failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      now(),
      send,
    );
  }
}

/** A run that can't go on: failed, with what was done kept (and undoable), one audit entry, a notice. */
async function fail(
  pool: pg.Pool,
  db: ReturnType<typeof drizzle<typeof schema>>,
  run: RunRow,
  error: string,
  now: Date,
  send: Send,
) {
  const [row] = await db
    .update(R)
    .set({ status: "failed", error, finishedAt: now })
    .where(eq(R.id, run.id))
    .returning();
  await pool.query(
    "INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, diff) VALUES ($1, 'lead.bulk', 'lead', NULL, $2)",
    [run.userId, { ...auditDiff(row!), error }],
  );
  const done = row!.done.toLocaleString("en-US");
  await send(run.userId, {
    kind: "bulk_done",
    title:
      error === "Their access changed"
        ? `A bulk action stopped after ${done} leads: your access changed. What was done stays.`
        : `A bulk action stopped after ${done} leads. What was done stays.`,
    data: { run: run.id },
  }).catch(() => undefined);
}
