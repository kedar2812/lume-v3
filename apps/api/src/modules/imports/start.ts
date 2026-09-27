import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  analyzeColumns,
  can,
  fold,
  resolveColumnSettings,
  validateMapping,
  type ColumnMap,
  type Mapping,
  type Rules,
} from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden } from "../../http/errors";
import { createTag } from "../catalog/service";
import { createField, updateField } from "../fields/service";
import { loadMapContext } from "./context";
import { readImportFile } from "./files";
import { getImport, mine, signature } from "./service";

const I = schema.imports;
const TAG_LABEL_MAX = 60; // the Tags screen's own limit

/** A field key from a label: lower-case, underscores, starting with a letter, unique, within the key rule's 40. */
function fieldKey(label: string, taken: Set<string>): string {
  let base =
    fold(label)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "field";
  if (!/^[a-z]/.test(base)) base = `f_${base}`;
  base = base.slice(0, 36).replace(/_+$/, "");
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

/** The cells of a tags column, split the way mapRow splits them. */
function tagParts(c: ColumnMap, cell: string): string[] {
  const on = c.to !== "ignore" ? c.transform?.splitOn : undefined;
  return cell
    .split(on ? new RegExp(`\\s*\\${on}\\s*`) : /\s*[,;]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Spec §7.1. Re-checks the mapping and rules against today's fields and stages, and the whole file's date
 * columns; then creates the chosen new fields, options and tags, points the mapping at them, remembers
 * the mapping for files with these columns, and queues the run. One transaction: a refusal leaves nothing.
 */
export async function startImport(req: FastifyRequest, d: AppDeps, id: string) {
  // Lock first, so two Starts at once queue one run: the second waits here, then sees it's no longer a draft.
  await req.db.execute(sql`SELECT 1 FROM imports WHERE id = ${id} FOR UPDATE`);
  const imp = await mine(req, id);
  if (imp.status !== "draft") throw new HttpError(409, "NOT_DRAFT", "This import has already started.");
  const file = readImportFile(d.keyring, imp);
  const rules = imp.rules as Rules;
  const draftMapping = imp.mapping as Mapping;
  const ctx = await loadMapContext(req, {
    pipelineId: rules.pipelineId,
    headerCount: file.headers.length,
    pending: draftMapping,
  });
  const settings = resolveColumnSettings(analyzeColumns(file.rows, draftMapping, ctx), draftMapping, ctx);
  const problems = [...validateMapping(draftMapping, rules, ctx), ...settings.blocking];
  if (problems.length) throw badRequest("MAPPING_INVALID", problems[0]!.message, problems);

  // New fields, then new options, then missing tags — and the mapping now points at real ones.
  const taken = new Set(ctx.fields.map((f) => f.key));
  const columns: ColumnMap[] = [];
  for (const c of draftMapping.columns) {
    if (c.to !== "new_field") {
      columns.push(c);
      continue;
    }
    const key = fieldKey(c.label, taken);
    taken.add(key);
    await createField(req, { key, label: c.label.trim(), type: c.type });
    columns.push({
      column: c.column,
      to: "field",
      field: key,
      ...(c.transform ? { transform: c.transform } : {}),
    });
  }
  for (const [key, labels] of Object.entries(draftMapping.addOptions ?? {})) {
    const [def] = await req.db
      .select()
      .from(schema.fieldDefinitions)
      .where(eq(schema.fieldDefinitions.key, key));
    if (!def) continue;
    const live = def.options.filter((o) => !o.archived);
    const fresh = [...new Map(labels.map((l) => [fold(l), l.trim()])).values()].filter(
      (l) => !live.some((o) => fold(o.label) === fold(l)),
    );
    // Existing options go back unchanged (colour included): updateField archives any it isn't sent.
    if (fresh.length)
      await updateField(req, def.id, {
        options: [
          ...live.map((o) => ({ id: o.id, label: o.label, ...(o.color ? { color: o.color } : {}) })),
          ...fresh.map((label) => ({ label })),
        ],
      });
  }
  if (draftMapping.createMissingTags) {
    const created = new Set(ctx.tags.map((t) => fold(t.label)));
    for (const c of columns.filter((x) => x.to === "field" && x.field === "tags"))
      for (const row of file.rows)
        for (const part of tagParts(c, row[c.column] ?? "")) {
          if (created.has(fold(part)) || part.length > TAG_LABEL_MAX) continue; // too long: that row errors
          created.add(fold(part));
          await createTag(req, { label: part });
        }
  }
  const mapping: Mapping = { columns, createMissingTags: false };
  const columnSettings = { dateOrders: settings.dateOrders, decimalMarks: settings.decimalMarks };

  await req.db
    .insert(schema.importMappingMemory)
    .values({ headerSignature: signature(file.headers), mapping, rules, updatedBy: req.actor!.userId })
    .onConflictDoUpdate({
      target: schema.importMappingMemory.headerSignature,
      set: { mapping, rules, updatedBy: req.actor!.userId, updatedAt: new Date() },
    });
  await req.db
    .update(I)
    .set({
      status: "queued",
      mapping,
      rules,
      columnSettings,
      startedBy: req.actor!.userId,
      startedAt: new Date(),
      attempts: 0,
    })
    .where(eq(I.id, id));
  await audit(req, {
    action: "import.started",
    entityType: "import",
    entityId: id,
    diff: { file: imp.fileName, rows: file.rows.length },
  });
  req.afterCommit(() => void d.imports?.enqueue(id));
  return getImport(req, id);
}

/** A queued import stops at once; a running one stops before its next batch of 200 (spec §7.3). */
export async function cancelImport(req: FastifyRequest, id: string) {
  const imp = await mine(req, id);
  if (imp.status === "queued")
    await req.db
      .update(I)
      .set({ status: "cancelled", stopReason: "cancelled", finishedAt: new Date() })
      .where(eq(I.id, id));
  else if (imp.status === "running") await req.db.update(I).set({ status: "cancelling" }).where(eq(I.id, id));
  else if (imp.status !== "cancelling") throw new HttpError(409, "NOT_RUNNING", "This import isn't running.");
  await audit(req, { action: "import.cancelled", entityType: "import", entityId: id });
  return getImport(req, id);
}

/** Carries on from the last finished row, as whoever resumes it — who must be allowed to run it. */
export async function resumeImport(req: FastifyRequest, d: AppDeps, id: string) {
  const imp = await mine(req, id);
  if (!["cancelled", "stopped_access", "failed"].includes(imp.status))
    throw new HttpError(409, "NOT_RESUMABLE", "This import can't be resumed.");
  const actor = req.actor!;
  const rules = imp.rules as Rules;
  const mapping = imp.mapping as Mapping;
  const givesAway =
    rules.owner.mode === "round_robin" ||
    (rules.owner.mode === "user" && rules.owner.userId !== actor.userId) ||
    mapping.columns.some((c) => c.to === "field" && c.field === "owner");
  if (givesAway && !can(actor, "leads.assign"))
    throw forbidden("CANNOT_ASSIGN", "This import gives leads to other people, which your role can't do.");
  await req.db
    .update(I)
    .set({ status: "queued", attempts: 0, stopReason: null, finishedAt: null, startedBy: actor.userId })
    .where(eq(I.id, id));
  await audit(req, { action: "import.resumed", entityType: "import", entityId: id });
  req.afterCommit(() => void d.imports?.enqueue(id));
  return getImport(req, id);
}

/** The finished-import notice has been seen (it stops showing). */
export async function markSeen(req: FastifyRequest, id: string) {
  await mine(req, id);
  await req.db.update(I).set({ seenAt: new Date() }).where(eq(I.id, id));
}
