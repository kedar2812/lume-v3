import { createHash } from "node:crypto";
import { and, asc, desc, eq, lt, ne, or } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  DEFAULT_RULES,
  INTAKE_LIMITS,
  MAPPABLE_TARGETS,
  analyzeColumns,
  can,
  mapRow,
  newId,
  readCsv,
  resolveColumnSettings,
  suggestMapping,
  validateMapping,
  type Issue,
  type LeadDraft,
  type Mapping,
  type Rules,
} from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, notFound } from "../../http/errors";
import { contactProbes, findMatches, loadMapContext } from "./context";
import { readImportFile, sealFile } from "./files";
import { withJobRequest } from "./job-request";

const I = schema.imports;
type ImportRow = typeof I.$inferSelect;

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** Files with the same columns share a remembered mapping (spec §4.4), whatever their order of rows. */
export const signature = (headers: string[]) =>
  sha(JSON.stringify(headers.map((h) => h.trim().toLowerCase())));
// Path separators, reserved characters and control characters never reach a stored file name.
const RESERVED = '/:*?"<>|';
const unsafe = (c: string) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 92 || RESERVED.includes(c); // 92: backslash
const safeName = (n: string) =>
  [...n]
    .map((c) => (unsafe(c) ? " " : c))
    .join("")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, 200) || "import.csv";

const notDraft = () => new HttpError(409, "NOT_DRAFT", "This import has already started.");

/** An import the caller may act on: a draft only by the person who uploaded it (others get 404). */
export async function mine(req: FastifyRequest, id: string): Promise<ImportRow> {
  const [imp] = await req.db.select().from(I).where(eq(I.id, id));
  if (!imp || (imp.status === "draft" && imp.createdBy !== req.actor!.userId))
    throw notFound("IMPORT_NOT_FOUND", "Import not found");
  return imp;
}

/** The default pipeline and its first open stage (spec §6.5). */
export async function defaultRules(req: FastifyRequest, country: string | null): Promise<Rules> {
  const [pipeline] = await req.db
    .select()
    .from(schema.pipelines)
    .where(and(eq(schema.pipelines.isDefault, true)));
  const [stage] = await req.db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.pipelineId, pipeline!.id), eq(schema.stages.kind, "open")))
    .orderBy(asc(schema.stages.position))
    .limit(1);
  return DEFAULT_RULES({ pipelineId: pipeline!.id, stageId: stage!.id, country });
}

/** The full screen state for a draft: the file as read, the mapping, the rules, analysis and problems. */
export async function draftView(req: FastifyRequest, d: AppDeps, imp: ImportRow) {
  const file = readImportFile(d.keyring, imp);
  const mapping = imp.mapping as Mapping;
  const rules = imp.rules as Rules;
  const ctx = await loadMapContext(req, {
    pipelineId: rules.pipelineId,
    headerCount: file.headers.length,
    pending: mapping,
  });
  const analysis = analyzeColumns(file.rows, mapping, ctx);
  const settings = resolveColumnSettings(analysis, mapping, ctx);
  const problems: Issue[] = [...validateMapping(mapping, rules, ctx), ...settings.blocking];
  const [prior] = await req.db
    .select({ at: I.finishedAt, by: schema.users.name })
    .from(I)
    .leftJoin(schema.users, eq(schema.users.id, I.startedBy))
    .where(and(eq(I.fileSha256, imp.fileSha256), eq(I.status, "done"), ne(I.id, imp.id)))
    .orderBy(desc(I.finishedAt))
    .limit(1);
  const pipelines = await req.db
    .select({ id: schema.pipelines.id, name: schema.pipelines.name, isDefault: schema.pipelines.isDefault })
    .from(schema.pipelines)
    .orderBy(asc(schema.pipelines.position));
  return {
    id: imp.id,
    status: imp.status,
    fileName: imp.fileName,
    fileBytes: imp.fileBytes,
    encoding: file.encoding,
    delimiter: file.delimiter,
    headerRow: file.headerRow,
    headers: file.headers,
    sample: file.rows.slice(0, 5),
    rowCount: file.rows.length,
    fileWarnings: file.fileWarnings,
    mapping,
    rules,
    targets: MAPPABLE_TARGETS(ctx.fields),
    analysis,
    problems,
    alreadyImported: prior?.at ? { at: prior.at.toISOString(), by: prior.by } : null,
    choices: {
      pipelines,
      stages: ctx.stages,
      people: ctx.people.filter((p) => p.active).map(({ id, name, email }) => ({ id, name, email })),
      fields: ctx.fields.filter((f) => !f.archived),
    },
    can: { assign: ctx.canAssign, manageFields: ctx.canManageFields, manageTags: ctx.canManageTags },
  };
}
export type DraftView = Awaited<ReturnType<typeof draftView>>;

/** A draft from bytes the 2A reader understands: a CSV upload, or a sheet's snapshot (2B, amendment A1). */
export async function createDraftFrom(
  req: FastifyRequest,
  d: AppDeps,
  o: {
    bytes: Buffer;
    fileName: string;
    kind: "csv" | "sheet";
    sourceId: string;
    headerRow?: number;
    mapping?: Mapping;
    rules?: Rules;
    targetSourceId?: string;
  },
): Promise<DraftView> {
  const file = readCsv(new Uint8Array(o.bytes), {
    allowNoRows: o.kind === "sheet",
    fileName: o.fileName,
    ...(o.headerRow ? { headerRow: o.headerRow } : {}),
  });
  if (!file.ok) throw badRequest(file.code, file.message);
  const [settings] = await req.db.select().from(schema.settings).where(eq(schema.settings.id, 1));
  let rules = o.rules ?? (await defaultRules(req, settings!.defaultCountryIso));
  const [memory] = o.mapping
    ? []
    : await req.db
        .select()
        .from(schema.importMappingMemory)
        .where(eq(schema.importMappingMemory.headerSignature, signature(file.headers)));
  // Remembered rules apply only while their pipeline and stage still exist.
  const remembered = memory?.rules as Rules | undefined;
  if (remembered && !o.rules) {
    const ctx = await loadMapContext(req, {
      pipelineId: remembered.pipelineId,
      headerCount: file.headers.length,
    });
    if (ctx.stages.some((s) => s.id === remembered.stageId)) rules = { ...rules, ...remembered };
  }
  const ctx = await loadMapContext(req, { pipelineId: rules.pipelineId, headerCount: file.headers.length });
  // A given mapping (an edit of a live sheet) keeps only columns the sheet still has.
  const mapping = o.mapping
    ? { ...o.mapping, columns: o.mapping.columns.filter((c) => c.column < file.headers.length) }
    : suggestMapping(file.headers, ctx.fields, (memory?.mapping as Mapping | undefined) ?? null);
  const id = newId();
  const [imp] = await req.db
    .insert(I)
    .values({
      id,
      sourceId: o.sourceId,
      kind: o.kind,
      status: "draft",
      fileEnc: sealFile(d.keyring, id, o.bytes),
      fileSha256: sha(o.bytes),
      fileName: o.fileName,
      fileBytes: o.bytes.length,
      encoding: file.encoding,
      delimiter: file.delimiter,
      headerRow: file.headerRow,
      headers: file.headers,
      rowCount: file.rows.length,
      mapping,
      rules,
      createdBy: req.actor!.userId,
      targetSourceId: o.targetSourceId ?? null,
    })
    .returning();
  return draftView(req, d, imp!);
}

export async function uploadImport(req: FastifyRequest, d: AppDeps, bytes: Buffer, rawName: string) {
  const fileName = safeName(rawName);
  if (bytes.length > INTAKE_LIMITS.bytes)
    throw badRequest("FILE_TOO_BIG", "This file is over 10 MB. Split it into smaller files.");
  const sourceId = newId();
  await req.db
    .insert(schema.leadSources)
    .values({ id: sourceId, type: "csv", name: fileName, createdBy: req.actor!.userId });
  // A file LUME can't read throws inside this request's transaction, so the source above is never kept.
  return createDraftFrom(req, d, { bytes, fileName, kind: "csv", sourceId });
}

export type ImportPatch = {
  encoding?: string;
  delimiter?: string;
  headerRow?: number;
  mapping?: Mapping;
  rules?: Rules;
};

/**
 * Changing the header row re-suggests the mapping (the columns changed); changing the encoding or
 * delimiter keeps it while the column count stays the same, else re-suggests. A mapping sent in the same
 * patch always wins.
 */
export async function patchImport(req: FastifyRequest, d: AppDeps, id: string, patch: ImportPatch) {
  const imp = await mine(req, id);
  if (imp.status !== "draft") throw notDraft();
  let next: ImportRow = {
    ...imp,
    ...(patch.mapping ? { mapping: patch.mapping } : {}),
    ...(patch.rules ? { rules: patch.rules } : {}),
  };
  if (patch.encoding !== undefined || patch.delimiter !== undefined || patch.headerRow !== undefined) {
    next = {
      ...next,
      encoding: patch.encoding ?? imp.encoding,
      delimiter: patch.delimiter ?? imp.delimiter,
      headerRow: patch.headerRow ?? imp.headerRow,
    };
    const file = readImportFile(d.keyring, next);
    const reshaped = patch.headerRow !== undefined || file.headers.length !== imp.headers.length;
    if (reshaped && !patch.mapping) {
      const ctx = await loadMapContext(req, {
        pipelineId: (next.rules as Rules).pipelineId,
        headerCount: file.headers.length,
      });
      next.mapping = suggestMapping(file.headers, ctx.fields, null);
    }
    next = {
      ...next,
      headers: file.headers,
      rowCount: file.rows.length,
      headerRow: file.headerRow,
      encoding: file.encoding,
      delimiter: file.delimiter,
    };
  }
  const [saved] = await req.db
    .update(I)
    .set({
      encoding: next.encoding,
      delimiter: next.delimiter,
      headerRow: next.headerRow,
      headers: next.headers,
      rowCount: next.rowCount,
      mapping: next.mapping,
      rules: next.rules,
    })
    .where(eq(I.id, id))
    .returning();
  return draftView(req, d, saved!);
}

export async function getDraft(req: FastifyRequest, d: AppDeps, id: string) {
  const imp = await mine(req, id);
  if (imp.status !== "draft") throw notDraft();
  return draftView(req, d, imp);
}

type Outcome = "create" | "merge" | "skip" | "error" | "empty";
type MergeInto =
  | { visible: true; leadId: string; name: string; ownerName: string | null }
  | { visible: false }
  | { row: number }
  | null;
export type PreviewRow = {
  rowNumber: number;
  outcome: Outcome;
  name: string | null;
  mergeInto: MergeInto;
  alsoMatches: number;
  problems: Issue[];
  warnings: Issue[];
};

/** With "create missing tags" on, an unknown tag isn't a problem: LUME creates it at Start. */
function splitTagMisses(mapping: Mapping, problems: Issue[], warnings: Issue[]) {
  if (!mapping.createMissingTags) return { problems, warnings };
  const misses = problems.filter((p) => p.code === "TAG_UNKNOWN");
  return {
    problems: problems.filter((p) => p.code !== "TAG_UNKNOWN"),
    warnings: [
      ...warnings,
      ...misses.map((p) => ({
        ...p,
        code: "TAG_WILL_BE_CREATED",
        message: p.message.replace("No tag called", "LUME will create the tag"),
      })),
    ],
  };
}

/**
 * Spec §6.11: exactly what Start would do with these rows. Two transactions: the request's own (as the
 * importer) decides what the importer may learn about a matched lead; one lead_scope 'all' transaction
 * finds matches among every lead. `errorsOnly` scans the whole file (mapping only, no duplicate check) and
 * returns up to 20 rows with problems.
 */
export async function previewImport(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  o: { rows?: number[]; errorsOnly?: boolean } = {},
) {
  const imp = await mine(req, id);
  if (imp.status !== "draft") throw notDraft();
  const file = readImportFile(d.keyring, imp);
  const mapping = imp.mapping as Mapping;
  const rules = imp.rules as Rules;
  const base = await loadMapContext(req, {
    pipelineId: rules.pipelineId,
    headerCount: file.headers.length,
    pending: mapping,
  });
  const settings = resolveColumnSettings(analyzeColumns(file.rows, mapping, base), mapping, base);
  if (settings.blocking.length)
    throw badRequest("PREVIEW_BLOCKED", settings.blocking[0]!.message, settings.blocking);
  const ctx = { ...base, dateOrders: settings.dateOrders, decimalMarks: settings.decimalMarks };
  const empty = (): Record<Outcome, number> => ({ create: 0, merge: 0, skip: 0, error: 0, empty: 0 });

  if (o.errorsOnly) {
    const rows: PreviewRow[] = [];
    for (let i = 0; i < file.rows.length && rows.length < INTAKE_LIMITS.previewRows; i++) {
      const out = mapRow(file.rows[i]!, mapping, rules, ctx);
      if (out.kind !== "error") continue;
      const { problems, warnings } = splitTagMisses(mapping, out.problems, out.warnings);
      if (problems.length)
        rows.push({
          rowNumber: file.rowNumbers[i]!,
          outcome: "error",
          name: null,
          mergeInto: null,
          alsoMatches: 0,
          problems,
          warnings,
        });
    }
    return { rows, summary: { ...empty(), error: rows.length }, scanned: file.rows.length };
  }

  const wanted = o.rows?.length ? new Set(o.rows) : null;
  const picks = file.rowNumbers
    .map((n, i) => ({ n, i }))
    .filter((x) => !wanted || wanted.has(x.n))
    .slice(0, INTAKE_LIMITS.previewRows);

  // Map every picked row first, then look up all their matches in one all-leads transaction.
  const mapped = picks.map(({ n, i }) => ({ n, out: mapRow(file.rows[i]!, mapping, rules, ctx) }));
  const drafts = mapped.flatMap((m) => (m.out.kind === "draft" ? [m.out.draft] : []));
  const matchesOf = new Map<LeadDraft, { leadId: string }[]>();
  if (drafts.length && rules.matchOn.length)
    await withJobRequest(
      {
        app: req.server,
        pool: d.jobPool ?? d.pool,
        actor: req.actor!,
        requestId: `${req.id}:preview`,
        allLeads: true,
      },
      async (all) => {
        for (const draft of drafts) matchesOf.set(draft, await findMatches(all, draft, rules.matchOn));
      },
    );

  const createdBy = new Map<string, number>(); // contact hash → the row that would create that lead
  const rows: PreviewRow[] = [];
  for (const { n, out } of mapped) {
    if (out.kind === "empty") {
      rows.push({
        rowNumber: n,
        outcome: "empty",
        name: null,
        mergeInto: null,
        alsoMatches: 0,
        problems: [],
        warnings: [],
      });
      continue;
    }
    const split = splitTagMisses(mapping, out.kind === "error" ? out.problems : [], out.warnings);
    if (out.kind === "error" && split.problems.length) {
      rows.push({ rowNumber: n, outcome: "error", name: null, mergeInto: null, alsoMatches: 0, ...split });
      continue;
    }
    if (out.kind !== "draft") continue;
    const hashes = contactProbes(out.draft, rules.matchOn).map((p) => `${p.kind}:${p.hash}`);
    const earlier = hashes.map((h) => createdBy.get(h)).find((x) => x !== undefined);
    const matches = earlier === undefined ? (matchesOf.get(out.draft) ?? []) : [];
    const onMatch: Outcome =
      rules.onMatch === "merge" ? "merge" : rules.onMatch === "skip" ? "skip" : "create";
    let outcome: Outcome = "create";
    let mergeInto: MergeInto = null;
    if (earlier !== undefined) {
      outcome = onMatch;
      mergeInto = { row: earlier };
    } else if (matches.length) {
      outcome = onMatch;
      const [seen] = await req.db // the importer's own row-level security decides what they may learn
        .select({ id: schema.leads.id, name: schema.leads.name, ownerName: schema.users.name })
        .from(schema.leads)
        .leftJoin(schema.users, eq(schema.users.id, schema.leads.ownerId))
        .where(eq(schema.leads.id, matches[0]!.leadId));
      mergeInto = seen
        ? { visible: true, leadId: seen.id, name: seen.name, ownerName: seen.ownerName }
        : { visible: false };
    }
    if (outcome === "create") for (const h of hashes) if (!createdBy.has(h)) createdBy.set(h, n);
    rows.push({
      rowNumber: n,
      outcome,
      name: out.draft.name,
      mergeInto,
      alsoMatches: Math.max(0, matches.length - 1),
      problems: [],
      warnings: split.warnings,
    });
  }
  const summary = empty();
  for (const r of rows) summary[r.outcome]++;
  return { rows, summary, scanned: picks.length };
}

export async function discardImport(req: FastifyRequest, id: string) {
  const imp = await mine(req, id);
  if (imp.status !== "draft") throw new HttpError(409, "NOT_DRAFT", "Only a draft can be discarded.");
  await req.db.delete(schema.leadSources).where(eq(schema.leadSources.id, imp.sourceId)); // cascades to the import
  await audit(req, {
    action: "import.discarded",
    entityType: "import",
    entityId: id,
    diff: { file: imp.fileName },
  });
}

function view(req: FastifyRequest, imp: ImportRow, startedByName: string | null) {
  const actor = req.actor!;
  // Row detail is the importer's, or someone who could see every lead's full contact anyway.
  const rawHolder = can(actor, "leads.view", "all") && can(actor, "leads.contact.full");
  return {
    id: imp.id,
    status: imp.status,
    fileName: imp.fileName,
    rowCount: imp.rowCount,
    cursorRow: imp.cursorRow,
    counts: {
      created: imp.created,
      merged: imp.merged,
      skipped: imp.skipped,
      empty: imp.empty,
      errors: imp.errors,
      warnings: imp.warnings,
      nameFromContact: imp.nameFromContact,
      missingStageFields: imp.missingStageFields,
      phoneNeedsCountry: imp.phoneNeedsCountry,
    },
    startedBy: imp.startedBy ? { id: imp.startedBy, name: startedByName ?? "Someone" } : null,
    createdAt: imp.createdAt.toISOString(),
    startedAt: imp.startedAt?.toISOString() ?? null,
    finishedAt: imp.finishedAt?.toISOString() ?? null,
    seenAt: imp.seenAt?.toISOString() ?? null,
    stopReason: imp.stopReason,
    sourceId: imp.sourceId,
    canSeeRows: imp.startedBy === actor.userId || imp.createdBy === actor.userId || rawHolder,
    mine: imp.createdBy === actor.userId,
  };
}
export type ImportView = ReturnType<typeof view>;

export async function getImport(req: FastifyRequest, id: string): Promise<ImportView> {
  const [row] = await req.db
    .select({ imp: I, startedByName: schema.users.name })
    .from(I)
    .leftJoin(schema.users, eq(schema.users.id, I.startedBy))
    .where(eq(I.id, id));
  if (!row || (row.imp.status === "draft" && row.imp.createdBy !== req.actor!.userId))
    throw notFound("IMPORT_NOT_FOUND", "Import not found");
  return view(req, row.imp, row.startedByName);
}

const PAGE = 50;

/** Newest first. Ids are time-ordered (UUIDv7), so the last id on a page is an exact cursor. */
export async function listImports(req: FastifyRequest, cursor?: string) {
  // Sheet drafts are how a Google Sheet is set up (2B amendment A1), never an import to list.
  const visible = and(ne(I.kind, "sheet"), or(ne(I.status, "draft"), eq(I.createdBy, req.actor!.userId)));
  const rows = await req.db
    .select({ imp: I, startedByName: schema.users.name })
    .from(I)
    .leftJoin(schema.users, eq(schema.users.id, I.startedBy))
    .where(cursor ? and(visible, lt(I.id, cursor)) : visible)
    .orderBy(desc(I.id))
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  return {
    imports: page.map((r) => view(req, r.imp, r.startedByName)),
    nextCursor: rows.length > PAGE ? page.at(-1)!.imp.id : null,
  };
}
