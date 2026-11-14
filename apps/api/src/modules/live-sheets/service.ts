import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  LIVE_SHEETS_MAX,
  can,
  liveSheetRuleSchema,
  newId,
  ruleWords,
  seesFullContacts,
  tierAllows,
  tierName,
  tiersWith,
  type LiveSheetPreset,
  type LiveSheetRule,
} from "@lume/core";
import { schema } from "@lume/db";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden, notFound } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { columnsFor } from "../lead-exports/make";
import { grantTokens } from "../sheets/google";
import { sheetsOn } from "../sheets/service";
import { grantContext, requireLiveSheets } from "./connect";
import { ABOUT_TAB, liveSheetsGoogle } from "./google";
import { requestRunIn, type RunTrigger } from "./queue";
import { countRule } from "./rows";

/** Live sheets (spec 2026-11-14 §1, §2, §6, §7): what the page and the form ask of LUME. */
const LS = schema.liveSheets;
const RUNS = schema.liveSheetRuns;
const U = schema.users;

export const sheetName = z
  .string()
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .pipe(z.string().min(1, "Give the sheet a name").max(100, "A name of up to 100 characters"));
export const createBody = z.object({
  name: sheetName,
  preset: z.enum(["meta", "own"]),
  rule: liveSheetRuleSchema,
  columns: z.array(z.string().min(1).max(80)).max(60),
  edits: z.enum(["keep", "replace"]),
  grantId: z.uuid(),
});
export const editBody = z
  .object({
    name: sheetName,
    preset: z.enum(["meta", "own"]),
    rule: liveSheetRuleSchema,
    columns: z.array(z.string().min(1).max(80)).max(60),
    edits: z.enum(["keep", "replace"]),
  })
  .partial();
export const countBody = z.object({ preset: z.enum(["meta", "own"]), rule: liveSheetRuleSchema });

const tierRefusal = (tier: string) =>
  new HttpError(
    403,
    "LIVE_SHEETS_TIER",
    `Live sheets come with ${tiersWith("live_sheets")}. Your LUME is on ${tier}.`,
  );

/** What making or changing one needs beyond the permission: the plan, Export leads, Google Sheets on. */
async function allowed(req: FastifyRequest, d: AppDeps): Promise<void> {
  await requireLiveSheets(req, d);
  const plan = req.server.licence.view().plan;
  if (!tierAllows(plan, "live_sheets")) throw tierRefusal(tierName(plan!.tier!));
}

/** A sheet's columns as the person may have them; a hidden or unknown one, or contacts they see masked, refused. */
async function checkColumns(req: FastifyRequest, preset: LiveSheetPreset, ids: string[]): Promise<string[]> {
  if (preset === "meta") {
    if (!seesFullContacts(req.actor!)) throw contactsMasked();
    return [];
  }
  const wanted = ["name", ...ids.filter((x) => x !== "name")];
  const kept = columnsFor(req, wanted, await loadFieldRegistry(req));
  if (kept.length !== new Set(wanted).size)
    throw badRequest(
      "COLUMN_HIDDEN",
      "LUME can't put one of those columns in: it's hidden from you, or gone.",
    );
  if (kept.some((c) => c.contact === "email" || c.contact === "phone") && !seesFullContacts(req.actor!))
    throw contactsMasked();
  return kept.map((c) => c.id);
}
const contactsMasked = () =>
  new HttpError(
    403,
    "CONTACTS_MASKED",
    "A live sheet needs phone numbers and emails in full. Your role sees them masked.",
  );

const reserved = (name: string) => {
  if (name.toLowerCase() === ABOUT_TAB.toLowerCase())
    throw badRequest("NAME_RESERVED", `LUME names its own tab “${ABOUT_TAB}”. Choose another name.`);
};

export type LiveSheetView = Awaited<ReturnType<typeof viewsOf>>[number];

async function viewsOf(req: FastifyRequest, ids?: string[]) {
  const rows = await req.db
    .select()
    .from(LS)
    .where(and(isNull(LS.deletedAt), ...(ids ? [inArray(LS.id, ids)] : [])))
    .orderBy(desc(LS.createdAt));
  if (!rows.length) return [];
  const people = new Map(
    (
      await req.db
        .select({ id: U.id, name: U.name })
        .from(U)
        .where(inArray(U.id, [...new Set(rows.flatMap((r) => [r.madeBy, r.runsAs]))]))
    ).map((p) => [p.id, p.name]),
  );
  const runs = new Map(
    (
      await req.db
        .select({ sheetId: RUNS.sheetId, total: RUNS.total, written: RUNS.written, status: RUNS.status })
        .from(RUNS)
        .where(
          and(
            inArray(
              RUNS.sheetId,
              rows.map((r) => r.id),
            ),
            inArray(RUNS.status, ["queued", "running"]),
          ),
        )
    ).map((r) => [r.sheetId, r]),
  );
  const names = await nameLookup(
    req,
    rows.map((r) => r.rule as LiveSheetRule),
  );
  return rows.map((r) => {
    const run = runs.get(r.id);
    return {
      id: r.id,
      name: r.name,
      preset: r.preset,
      rule: r.rule as LiveSheetRule,
      ruleWords: ruleWords(r.rule as LiveSheetRule, names),
      columns: r.columns,
      edits: r.edits,
      status: r.status,
      pauseReason: r.pauseReason,
      /** A passing trouble the last run met ("Google is slow"), cleared by the next good run. */
      lastError: r.lastError,
      url: r.url,
      leadCount: r.leadCount,
      capped: r.capped,
      lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
      run: run ? { total: run.total, written: run.written, status: run.status } : null,
      madeBy: { id: r.madeBy, name: people.get(r.madeBy) ?? "Someone" },
      runsAs: { id: r.runsAs, name: people.get(r.runsAs) ?? "Someone" },
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Names for every rule's words in one read per kind. */
async function nameLookup(req: FastifyRequest, rules: LiveSheetRule[]) {
  const all = (pick: (r: LiveSheetRule) => string[] | undefined) => [
    ...new Set(rules.flatMap((r) => pick(r) ?? [])),
  ];
  const map = async (ids: string[], read: (ids: string[]) => Promise<{ id: string; n: string }[]>) =>
    new Map((ids.length ? await read(ids) : []).map((x) => [x.id, String(x.n)]));
  const S = schema;
  const [stages, sources, tags, people, teams] = await Promise.all([
    map(
      all((r) => r.stages?.stageIds),
      (ids) =>
        req.db.select({ id: S.stages.id, n: S.stages.name }).from(S.stages).where(inArray(S.stages.id, ids)),
    ),
    map(
      all((r) => r.sourceIds),
      (ids) =>
        req.db
          .select({ id: S.leadSources.id, n: S.leadSources.name })
          .from(S.leadSources)
          .where(inArray(S.leadSources.id, ids)),
    ),
    map(
      all((r) => r.tagIds),
      (ids) => req.db.select({ id: S.tags.id, n: S.tags.label }).from(S.tags).where(inArray(S.tags.id, ids)),
    ),
    map(
      all((r) => r.ownerIds),
      (ids) =>
        req.db.select({ id: S.users.id, n: S.users.name }).from(S.users).where(inArray(S.users.id, ids)),
    ),
    map(
      all((r) => r.teamIds),
      (ids) =>
        req.db.select({ id: S.teams.id, n: S.teams.name }).from(S.teams).where(inArray(S.teams.id, ids)),
    ),
  ]);
  const pick = (m: Map<string, string>, fallback: string) => (id: string) => m.get(id) ?? fallback;
  return {
    stage: pick(stages, "a stage"),
    source: pick(sources, "a source"),
    tag: pick(tags, "a tag"),
    person: pick(people, "someone"),
    team: pick(teams, "a team"),
  };
}

/** Every live sheet, and whether new ones can be made here (Google Sheets on, Connect with Google set up). */
export async function listSheets(req: FastifyRequest, d: AppDeps) {
  return {
    sheets: await viewsOf(req),
    setup: { sheetsOn: await sheetsOn(req), connectWithGoogle: !!d.googleOAuth },
  };
}

export async function oneSheet(req: FastifyRequest, id: string) {
  const [v] = await viewsOf(req, [id]);
  if (!v) throw notFound("LIVE_SHEET_NOT_FOUND", "That live sheet isn't here any more.");
  return { sheet: v };
}

export async function countSheet(req: FastifyRequest, d: AppDeps, body: z.infer<typeof countBody>) {
  await requireLiveSheets(req, d);
  return countRule(req, { preset: body.preset, rule: body.rule, createdAt: new Date() });
}

/** Asks for a run now and queues it once the request commits. */
async function runNow(req: FastifyRequest, d: AppDeps, sheetId: string, trigger: RunTrigger) {
  const r = await requestRunIn(req.db, { sheetId, trigger, requestedBy: req.actor!.userId });
  if (r.fresh) req.afterCommit(() => void d.liveSheets?.enqueue(r.runId, sheetId));
  return r;
}

export async function createSheet(req: FastifyRequest, d: AppDeps, body: z.infer<typeof createBody>) {
  await allowed(req, d);
  reserved(body.name);
  const [grant] = await req.db
    .select({ id: schema.liveSheetGrants.id })
    .from(schema.liveSheetGrants)
    .where(
      and(eq(schema.liveSheetGrants.id, body.grantId), eq(schema.liveSheetGrants.userId, req.actor!.userId)),
    );
  if (!grant) throw forbidden("GRANT_NOT_YOURS", "Choose one of your own Google accounts, or connect one.");
  const columns = await checkColumns(req, body.preset, body.columns);
  // One business at a time past the limit: the count and the insert under one lock.
  await req.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('live-sheets:create'))`);
  const [{ n }] = (await req.db.select({ n: count() }).from(LS).where(isNull(LS.deletedAt))) as [
    { n: number },
  ];
  if (n >= LIVE_SHEETS_MAX)
    throw new HttpError(
      409,
      "LIVE_SHEETS_FULL",
      `A business keeps up to ${LIVE_SHEETS_MAX} live sheets. Delete one you don't use to make another.`,
    );
  const id = newId();
  await req.db.insert(LS).values({
    id,
    name: body.name,
    preset: body.preset,
    rule: body.rule as unknown as Record<string, unknown>,
    columns,
    edits: body.edits,
    grantId: grant.id,
    madeBy: req.actor!.userId,
    runsAs: req.actor!.userId,
    status: "making",
  });
  await runNow(req, d, id, "make");
  await audit(req, {
    action: "live_sheet.created",
    entityType: "live_sheet",
    entityId: id,
    diff: { name: body.name, preset: body.preset },
  });
  return oneSheet(req, id);
}

async function locked(req: FastifyRequest, id: string) {
  const [s] = await req.db
    .select()
    .from(LS)
    .where(and(eq(LS.id, id), isNull(LS.deletedAt)))
    .for("update");
  if (!s) throw notFound("LIVE_SHEET_NOT_FOUND", "That live sheet isn't here any more.");
  return s;
}

export async function editSheet(req: FastifyRequest, d: AppDeps, id: string, body: z.infer<typeof editBody>) {
  await allowed(req, d);
  const s = await locked(req, id);
  if (body.name !== undefined) reserved(body.name);
  const preset = body.preset ?? s.preset;
  const columns =
    body.columns !== undefined || body.preset !== undefined
      ? await checkColumns(req, preset, body.columns ?? s.columns)
      : s.columns;
  await req.db
    .update(LS)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      preset,
      columns,
      ...(body.rule ? { rule: body.rule as unknown as Record<string, unknown> } : {}),
      ...(body.edits ? { edits: body.edits } : {}),
      // Due at once: a run already writing started before the edit, so the next tick takes it up.
      nextSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(LS.id, id));
  // The edits choice switched: what LUME knows of hand edits starts afresh from the sheet as it is now.
  if (body.edits && body.edits !== s.edits)
    await req.db.execute(
      sql`UPDATE live_sheet_rows SET edited_cols = '{}', removed_by_hand = false WHERE sheet_id = ${id}`,
    );
  if (s.status !== "paused") await runNow(req, d, id, "edit");
  await audit(req, {
    action: "live_sheet.edited",
    entityType: "live_sheet",
    entityId: id,
    diff: { name: body.name ?? s.name, changed: Object.keys(body) },
  });
  return oneSheet(req, id);
}

export async function runSheet(req: FastifyRequest, d: AppDeps, id: string) {
  await requireLiveSheets(req, d);
  await locked(req, id);
  await runNow(req, d, id, "now");
  return oneSheet(req, id);
}

export async function pauseSheet(req: FastifyRequest, d: AppDeps, id: string) {
  await requireLiveSheets(req, d);
  const s = await locked(req, id);
  if (s.status !== "paused")
    await req.db
      .update(LS)
      .set({ status: "paused", pauseReason: "paused_by_person", updatedAt: new Date() })
      .where(eq(LS.id, id));
  await audit(req, {
    action: "live_sheet.paused",
    entityType: "live_sheet",
    entityId: id,
    diff: { name: s.name },
  });
  return oneSheet(req, id);
}

export async function resumeSheet(req: FastifyRequest, d: AppDeps, id: string) {
  await allowed(req, d);
  const s = await locked(req, id);
  // Only a person's own pause is lifted here; Google's, the plan's or the maker's are lifted by their fix.
  if (s.pauseReason === "paused_by_person") {
    await req.db
      .update(LS)
      .set({
        status: s.spreadsheetId ? "live" : "making",
        pauseReason: null,
        nextSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(LS.id, id));
    await runNow(req, d, id, "now");
  }
  await audit(req, {
    action: "live_sheet.resumed",
    entityType: "live_sheet",
    entityId: id,
    diff: { name: s.name },
  });
  return oneSheet(req, id);
}

/** An admin (who manages people) runs it as themselves; the Google account it writes with stays. */
export async function takeOverSheet(req: FastifyRequest, d: AppDeps, id: string) {
  await allowed(req, d);
  const a = req.actor!;
  if (!a.isOwner && !can(a, "users.manage"))
    throw forbidden("TAKE_OVER_ADMIN", "Only someone who manages people can take a live sheet over.");
  const s = await locked(req, id);
  await req.db
    .update(LS)
    .set({
      runsAs: a.userId,
      ...(s.pauseReason === "maker_gone" ? { status: "live" as const, pauseReason: null } : {}),
      nextSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(LS.id, id));
  await runNow(req, d, id, "now");
  await audit(req, {
    action: "live_sheet.taken_over",
    entityType: "live_sheet",
    entityId: id,
    diff: { name: s.name, from: s.runsAs },
  });
  return oneSheet(req, id);
}

/** The file was deleted in Google (or LUME lost it): a new one with the same settings, filled from the start. */
export async function remakeSheet(req: FastifyRequest, d: AppDeps, id: string) {
  await allowed(req, d);
  const s = await locked(req, id);
  await req.db
    .update(LS)
    .set({
      spreadsheetId: null,
      url: null,
      tabId: null,
      writtenName: null,
      header: [],
      googleModifiedAt: null,
      status: "making",
      pauseReason: null,
      lastError: null,
      leadCount: 0,
      failures: 0,
      nextSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(LS.id, id));
  await req.db.execute(sql`DELETE FROM live_sheet_rows WHERE sheet_id = ${id}`);
  await runNow(req, d, id, "make");
  await audit(req, {
    action: "live_sheet.remade",
    entityType: "live_sheet",
    entityId: id,
    diff: { name: s.name },
  });
  return oneSheet(req, id);
}

/** Stops it; the file stays in Google Drive unless the person asks for it in Google's bin too. */
export async function deleteSheet(req: FastifyRequest, d: AppDeps, id: string, trash: boolean) {
  await requireLiveSheets(req, d);
  const s = await locked(req, id);
  await req.db.update(LS).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(LS.id, id));
  await req.db.execute(
    sql`UPDATE live_sheet_runs SET status = 'done', finished_at = now() WHERE sheet_id = ${id} AND status IN ('queued', 'running')`,
  );
  let trashed = false;
  if (trash && s.spreadsheetId && s.grantId && d.googleOAuth) {
    await req.db.execute(sql`SELECT set_config('lume.live_sheets_sweep', 'on', true)`);
    const [g] = await req.db
      .select({ enc: schema.liveSheetGrants.grantEnc })
      .from(schema.liveSheetGrants)
      .where(eq(schema.liveSheetGrants.id, s.grantId));
    await req.db.execute(sql`SELECT set_config('lume.live_sheets_sweep', '', true)`);
    if (g)
      try {
        await liveSheetsGoogle({
          tokens: grantTokens(d.googleOAuth, d.keyring.decrypt(g.enc, grantContext(s.grantId))),
          ...(d.googleEndpoint ? { endpoint: d.googleEndpoint } : {}),
        }).trash(s.spreadsheetId);
        trashed = true;
      } catch {
        // Google wouldn't: the sheet still stops; the person is told to bin the file themselves.
      }
  }
  await audit(req, {
    action: "live_sheet.deleted",
    entityType: "live_sheet",
    entityId: id,
    diff: { name: s.name, trashed },
  });
  return { deleted: true, trashed, url: s.url };
}
