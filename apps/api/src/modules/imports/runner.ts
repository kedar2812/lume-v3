import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  INTAKE_LIMITS,
  can,
  mapRow,
  startOfDayUtc,
  type DateOrder,
  type Issue,
  type Keyring,
  type LeadDraft,
  type Mapping,
  type Rules,
} from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { loadFieldRegistry } from "../../leads/fields";
import { loadActor, type ActorRecord } from "../../rbac/actor";
import { insertLead, mergeFill, mergeIntoLead } from "../leads/writer";
import { contactProbes, findMatches, loadMapContext, type FullMapContext } from "./context";
import { readImportFile } from "./files";
import { jobServer, withJobRequest } from "./job-request";

const I = schema.imports;
const R = schema.importRows;
/** pg-boss retries a thrown run (the queues are created with retryLimit 5); the fifth failure is final. */
export const MAX_ATTEMPTS = 5;

export type RunHooks = { crashAfterRows?: number; beforeBatch?: (n: number) => Promise<void> };
export type RunDeps = { app: FastifyInstance; pool: pg.Pool; keyring: Keyring; testHooks?: RunHooks };
type ImportRow = typeof I.$inferSelect;
type Db = ReturnType<typeof drizzle<typeof schema>>;
type ColumnSettings = { dateOrders: Record<number, DateOrder>; decimalMarks: Record<number, "." | ","> };

/** What identifies a row's person, for spotting the same row again later (Sheets, spec §8). */
const fingerprint = (d: LeadDraft, cells: string[]) => {
  const identity = [d.leadCreatedAt ?? "", d.phone.e164 ?? "", d.email ?? "", d.instagram ?? ""];
  const basis = identity.some(Boolean) ? identity : cells.map((c) => c.trim());
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex");
};

/** A transaction-scoped lock on one contact key (its first 64 bits), so two runs can't both create it. */
const lockContact = (hex: string) =>
  sql`SELECT pg_advisory_xact_lock(('x' || ${hex.slice(0, 16)})::bit(64)::bigint)`;

/** Does this run give leads to people other than the starter? Then it needs leads.assign as well. */
function givesAway(imp: ImportRow, actor: ActorRecord): boolean {
  const rules = imp.rules as Rules;
  const mapping = imp.mapping as Mapping;
  return (
    rules.owner.mode === "round_robin" ||
    (rules.owner.mode === "user" && rules.owner.userId !== actor.userId) ||
    mapping.columns.some((c) => c.to === "field" && c.field === "owner")
  );
}

/**
 * Spec §7.2: runs an import to the end, or until it's cancelled, loses access, or fails. Safe to call
 * again at any time: every row is claimed once, so a repeat carries on where the last attempt stopped.
 */
export async function runImport(o: RunDeps, importId: string): Promise<void> {
  o = { ...o, app: jobServer(o.app) };
  const db = drizzle(o.pool, { schema }); // the intake tables have no row-level security (amendment 5)
  const [claimed] = await db
    .update(I)
    .set({
      status: sql`CASE WHEN ${I.status} = 'cancelling' THEN ${I.status} ELSE 'running' END`,
      attempts: sql`${I.attempts} + 1`,
    })
    .where(sql`${I.id} = ${importId} AND ${I.status} IN ('queued', 'running', 'cancelling')`)
    .returning();
  if (!claimed) return; // cancelled, finished, or never started: nothing to do
  try {
    await runRows(o, db, claimed);
  } catch (e) {
    if (o.testHooks && String(e).includes("test crash")) throw e;
    const message = String((e as Error)?.message ?? e).slice(0, 300);
    if (claimed.attempts < MAX_ATTEMPTS) throw e; // pg-boss retries, with backoff
    await db
      .update(I)
      .set({ status: "failed", stopReason: `failed: ${message}`, finishedAt: new Date() })
      .where(eq(I.id, importId));
    await auditAs(o, claimed.startedBy, "import.failed", importId, { message });
  }
}

/** An audit entry as the person who started the import (or with no actor, if they no longer exist). */
async function auditAs(o: RunDeps, userId: string | null, action: string, importId: string, diff: object) {
  const actor = userId ? await loadActor(o.pool, userId) : null;
  if (!actor) {
    await o.pool.query(
      "INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, diff) VALUES ($1, $2, 'import', $3, $4)",
      [userId, action, importId, diff],
    );
    return;
  }
  await withJobRequest(
    { app: o.app, pool: o.pool, actor, requestId: `import:${importId}:${action}`, allLeads: false },
    (req) => audit(req, { action, entityType: "import", entityId: importId, diff: { ...diff } }),
  );
}

async function runRows(o: RunDeps, db: Db, imp: ImportRow) {
  const file = readImportFile(o.keyring, imp);
  const rules = imp.rules as Rules;
  const mapping = imp.mapping as Mapping;
  const columnSettings = imp.columnSettings as ColumnSettings;
  const startedBy = imp.startedBy!;
  const from = file.rowNumbers.findIndex((n) => n > imp.cursorRow);
  let committed = 0;

  for (
    let at = from === -1 ? file.rows.length : from, batch = 0;
    at < file.rows.length;
    at += INTAKE_LIMITS.batch, batch++
  ) {
    await o.testHooks?.beforeBatch?.(batch);
    const [now] = await db.select({ status: I.status }).from(I).where(eq(I.id, imp.id));
    if (now?.status === "cancelling") {
      await db
        .update(I)
        .set({ status: "cancelled", stopReason: "cancelled", finishedAt: new Date() })
        .where(eq(I.id, imp.id));
      return;
    }
    // Permissions, people and fields are read afresh before every batch (spec §7.3).
    const actor = await loadActor(o.pool, startedBy);
    if (!actor || !can(actor, "leads.import") || (givesAway(imp, actor) && !can(actor, "leads.assign"))) {
      await db
        .update(I)
        .set({ status: "stopped_access", stopReason: "access_changed", finishedAt: new Date() })
        .where(eq(I.id, imp.id));
      await auditAs(o, startedBy, "import.stopped", imp.id, { reason: "access_changed" });
      return;
    }
    const job = (suffix: string) => ({
      app: o.app,
      pool: o.pool,
      actor,
      requestId: `import:${imp.id}:${suffix}`,
      allLeads: true,
    });
    const ctx = await withJobRequest(job("context"), (req) =>
      loadMapContext(req, { pipelineId: rules.pipelineId, headerCount: file.headers.length, columnSettings }),
    );
    const end = Math.min(at + INTAKE_LIMITS.batch, file.rows.length);
    for (let i = at; i < end; i++) {
      const rowNumber = file.rowNumbers[i]!;
      await withJobRequest(job(String(rowNumber)), (req) =>
        oneRow(req, o.keyring, { imp, rules, mapping }, ctx, file.rows[i]!, rowNumber),
      );
      committed++;
      if (o.testHooks?.crashAfterRows !== undefined && committed >= o.testHooks.crashAfterRows)
        throw new Error("test crash");
    }
  }
  const [done] = await db
    .update(I)
    .set({ status: "done", finishedAt: new Date() })
    .where(sql`${I.id} = ${imp.id} AND ${I.status} IN ('running', 'cancelling')`)
    .returning({
      created: I.created,
      merged: I.merged,
      skipped: I.skipped,
      empty: I.empty,
      errors: I.errors,
    });
  if (done) await auditAs(o, startedBy, "import.finished", imp.id, done);
}

type Run = { imp: ImportRow; rules: Rules; mapping: Mapping };
type Counter =
  | "created"
  | "merged"
  | "skipped"
  | "empty"
  | "errors"
  | "warnings"
  | "name_from_contact"
  | "missing_stage_fields"
  | "phone_needs_country";
type Saved = {
  leadId?: string | null;
  problems?: Issue[];
  warnings?: Issue[];
  alsoMatched?: string[];
  fingerprint?: string | null;
};

/**
 * Spec §6.9–§6.10 for one row, inside its own transaction (every lead visible, acting as the importer).
 * Claim → map → lock the contacts → match → create, merge or skip → record the result and the counts.
 */
async function oneRow(
  req: FastifyRequest,
  keyring: Keyring,
  run: Run,
  ctx: FullMapContext,
  cells: string[],
  rowNumber: number,
) {
  const { imp, rules, mapping } = run;
  const [claimed] = await req.db
    .insert(R)
    .values({
      importId: imp.id,
      rowIndex: rowNumber,
      result: "pending",
      rawEnc: keyring.encrypt(JSON.stringify(cells), `import-row:${imp.id}:${rowNumber}`),
    })
    .onConflictDoNothing()
    .returning({ id: R.id });
  if (!claimed) return; // an earlier attempt already finished this row

  const save = async (
    result: "created" | "merged" | "skipped" | "error",
    f: Saved,
    counters: Partial<Record<Counter, number>>,
  ) => {
    await req.db
      .update(R)
      .set({
        result,
        leadId: f.leadId ?? null,
        problems: f.problems ?? [],
        warnings: f.warnings ?? [],
        alsoMatched: f.alsoMatched ?? [],
        fingerprint: f.fingerprint ?? null,
      })
      .where(eq(R.id, claimed.id));
    const sets = Object.entries(counters)
      .filter(([, n]) => n)
      .map(([k, n]) => sql`${sql.identifier(k)} = ${sql.identifier(k)} + ${n}`);
    await req.db.execute(
      sql`UPDATE imports SET ${sql.join([...sets, sql`cursor_row = GREATEST(cursor_row, ${rowNumber})`], sql`, `)} WHERE id = ${imp.id}`,
    );
  };
  const warned = (w: Issue[]) => (w.length ? 1 : 0);

  const outcome = mapRow(cells, mapping, rules, ctx);
  if (outcome.kind === "empty")
    return save(
      "skipped",
      { problems: [{ column: null, code: "EMPTY_ROW", message: "Empty row" }] },
      { empty: 1 },
    );
  if (outcome.kind === "error")
    return save(
      "error",
      { problems: outcome.problems, warnings: outcome.warnings },
      { errors: 1, warnings: warned(outcome.warnings) },
    );

  const draft = outcome.draft;
  const warnings = [...outcome.warnings];
  const fp = fingerprint(draft, cells);
  // A safety net behind mapRow: the field registry's own create schema, exactly as a hand-made lead meets it.
  const custom = (await loadFieldRegistry(req)).custom.create.safeParse(draft.custom);
  if (!custom.success)
    return save(
      "error",
      {
        problems: custom.error.issues.map((i) => ({
          column: null,
          code: "INVALID_FIELD",
          message: `${i.path.join(".")}: ${i.message}`,
        })),
        warnings,
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

  if (matches.length && rules.onMatch !== "duplicate") {
    const target = matches[0]!.leadId;
    if (rules.onMatch === "skip")
      return save(
        "skipped",
        {
          leadId: target,
          warnings,
          alsoMatched: also,
          fingerprint: fp,
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
      type: "imported_again",
      payload: {
        importId: imp.id,
        file: imp.fileName,
        row: rowNumber,
        filled,
        extraPhones: draft.extraPhones,
        warnings: warnings.map((w) => w.code),
      },
    });
    return save(
      "merged",
      { leadId: target, warnings, alsoMatched: also, fingerprint: fp },
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
      else {
        const { rows } = await req.db.execute<{ n: number }>(
          sql`UPDATE imports SET rr_cursor = rr_cursor + 1 WHERE id = ${imp.id} RETURNING rr_cursor - 1 AS n`,
        );
        ownerId = turns[Number(rows[0]!.n) % turns.length]!.id;
      }
    }
  }
  const stageId = draft.stageId ?? rules.stageId;
  const stage = ctx.stagesFull.find((s) => s.id === stageId);
  if (!stage)
    return save(
      "error",
      {
        problems: [
          { column: null, code: "STAGE_GONE", message: "The stage for new leads no longer exists." },
        ],
        warnings,
      },
      { errors: 1, warnings: warned(warnings) },
    );
  // The lead's own date, when the file has one, is when it entered its stage (and closed, if closed).
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
    sourceId: imp.sourceId,
    lostReasonId: draft.lostReasonId,
    closedAt: stage.kind === "open" ? null : (origin ?? new Date()),
    stageKind: stage.kind,
    stageEnteredAt: origin ?? new Date(),
    activity: {
      type: "imported",
      payload: {
        importId: imp.id,
        file: imp.fileName,
        row: rowNumber,
        extraPhones: draft.extraPhones,
        warnings: warnings.map((w) => w.code),
      },
    },
    assignReason: "imported",
  });
  // A stage's required fields aren't enforced on import (spec §6.5), but the leads missing them are counted.
  const core: Record<string, unknown> = {
    name: draft.name,
    phone: draft.phone.raw,
    email: draft.email,
    instagram: draft.instagram,
    value: draft.value,
    lead_created_at: draft.leadCreatedAt,
    owner: ownerId,
    stage: stageId,
    source: imp.sourceId,
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
  return save(
    "created",
    { leadId, warnings, alsoMatched: also, fingerprint: fp },
    {
      created: 1,
      warnings: warned(warnings),
      name_from_contact: draft.nameFromContact ? 1 : 0,
      phone_needs_country: draft.phone.status === "needs_country" ? 1 : 0,
      missing_stage_fields: missing ? 1 : 0,
    },
  );
}
