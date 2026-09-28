import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import Papa from "papaparse";
import {
  can,
  instanceIdOf,
  newId,
  sign,
  unseal,
  verify,
  type Handoff,
  type Mapping,
  type Rules,
} from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden, notFound } from "../../http/errors";
import { safeCell } from "../imports/report";
import { givesAway } from "../imports/runner";
import { createDraftFrom, mine, type DraftView } from "../imports/service";
import { prepareStart } from "../imports/start";
import { openConfig, sealConfig, type SheetConfig } from "./config";
import {
  GoogleError,
  isTransient,
  oauthClientFor,
  parseSheetLink,
  rowsRange,
  type GoogleSheets,
} from "./google";
import { gridToCsv, identityKey } from "./grid";
import { requestSync } from "./requests";

const S = schema.leadSources;
const SY = schema.sourceSyncs;
const SR = schema.sourceRows;
const I = schema.imports;
type Source = typeof S.$inferSelect;
/** The draft's snapshot: the 2A reader's own row limit (it refuses more), from row 1 so row numbers match. */
const SNAPSHOT_ROWS = 20_000;
const MAX_SHEETS = 20;
/** Attention a press of "Test again" can clear; the others need the columns opened and saved. */
const RETRYABLE = new Set(["ACCESS_LOST", "SHEET_GONE", "TAB_GONE", "TOO_MANY_ROWS", "GOOGLE_SETUP"]);

export type SyncView = {
  id: string;
  trigger: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  created: number;
  merged: number;
  errors: number;
  error: string | null;
};
export type ProblemRowView = {
  id: number;
  rowNumber: number;
  problems: { code: string; message: string }[];
  lastTriedAt: string;
};

// ——— The module switch (spec §3) ———

export async function sheetsOn(req: FastifyRequest): Promise<boolean> {
  const [s] = await req.db
    .select({ i: schema.settings.integrations })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  return !!s?.i.googleSheets?.enabled;
}

export async function integrationsView(req: FastifyRequest, d: AppDeps) {
  return {
    googleSheets: {
      enabled: await sheetsOn(req),
      // Either way of reading sheets makes the module available: a service account, or Connect with Google.
      available: !!d.google || !!d.googleOAuth,
      email: d.google?.email ?? null,
      connectWithGoogle: !!d.googleOAuth,
    },
  };
}

export async function setSheetsEnabled(req: FastifyRequest, d: AppDeps, enabled: boolean) {
  if (enabled && !d.google && !d.googleOAuth)
    throw new HttpError(
      409,
      "NOT_CONFIGURED",
      "Google Sheets isn't set up on this server yet. The person who installed LUME can add its Google key.",
    );
  await req.db.execute(
    sql`UPDATE settings SET integrations = jsonb_set(integrations, '{googleSheets}', ${JSON.stringify({ enabled })}::jsonb) WHERE id = 1`,
  );
  await audit(req, {
    action: enabled ? "integration.enabled" : "integration.disabled",
    entityType: "integration",
    diff: { module: "google_sheets" },
  });
  return integrationsView(req, d);
}

async function requireOn(req: FastifyRequest, d: AppDeps): Promise<GoogleSheets | null> {
  if (!d.google && !d.googleOAuth)
    throw new HttpError(409, "NOT_CONFIGURED", "Google Sheets isn't set up on this server yet.");
  if (!(await sheetsOn(req)))
    throw new HttpError(
      409,
      "SHEETS_OFF",
      "Google Sheets is switched off. Switch it on in Settings → Integrations.",
    );
  return d.google ?? null;
}

/** A Google call from a screen: its refusals as the messages the screen shows. */
async function fromGoogle<T>(google: GoogleSheets, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof GoogleError && e.kind === "access")
      throw new HttpError(
        409,
        "SHEET_NO_ACCESS",
        `LUME can't open this sheet yet. Share it with ${google.email} as a Viewer, then try again.`,
      );
    if (e instanceof GoogleError && e.kind === "not_found")
      throw new HttpError(404, "SHEET_NOT_FOUND", "LUME couldn't find this sheet. Check the link.");
    if (e instanceof GoogleError && e.kind === "setup")
      throw new HttpError(
        503,
        "GOOGLE_SETUP",
        "LUME's Google connection isn't set up right. Tell the person who installed LUME.",
      );
    if (isTransient(e))
      throw new HttpError(503, "GOOGLE_UNAVAILABLE", "LUME couldn't reach Google. Try again in a minute.");
    throw e;
  }
}

// ——— Connect with Google (spec §6, plan 2B-2) ———

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A signed link to the relay, for this person; its nonce is single-use and expires with the hand-back. */
export async function connectStart(req: FastifyRequest, d: AppDeps, body: { sourceId?: string } = {}) {
  await requireOn(req, d);
  if (!d.googleOAuth)
    throw new HttpError(409, "NOT_CONFIGURED", "Connect with Google isn't set up on this server.");
  const { relayUrl, relayToken } = d.googleOAuth;
  const nonce = randomBytes(24).toString("base64url");
  await req.db.insert(schema.oauthConnects).values({
    id: newId(),
    userId: req.actor!.userId,
    nonceHash: sha256(nonce),
    // "Connect again": this connect gives an existing sheet a new grant (2B-2 final review).
    targetSourceId: body.sourceId ? (await liveSource(req, body.sourceId)).id : null,
  });
  const url = new URL("/start", relayUrl);
  url.search = new URLSearchParams({
    i: instanceIdOf(relayToken),
    n: nonce,
    s: sign(relayToken, nonce),
  }).toString();
  return { url: url.toString() };
}

/**
 * Back from Google (Review Focus 1): the hand-back must be signed and sealed with this instance's token,
 * fresh, and match a connect this same person started and hasn't finished. Its grant is then kept (sealed
 * to this connect) until a sheet is made from the picked file.
 */
export async function connectComplete(req: FastifyRequest, d: AppDeps, body: { p: string; s: string }) {
  await requireOn(req, d);
  if (!d.googleOAuth)
    throw new HttpError(409, "NOT_CONFIGURED", "Connect with Google isn't set up on this server.");
  const token = d.googleOAuth.relayToken;
  const invalid = () =>
    badRequest("CONNECT_INVALID", "This connection isn't valid. Try Connect with Google again.");
  if (!verify(token, body.p, body.s)) throw invalid();
  const h = unseal<Handoff>(token, body.p);
  if (!h || typeof h.nonce !== "string" || typeof h.refreshToken !== "string" || !h.file?.id) throw invalid();
  if (h.exp < Date.now())
    throw badRequest("CONNECT_EXPIRED", "This connection took too long. Try Connect with Google again.");
  const OC = schema.oauthConnects;
  const [row] = await req.db
    .select()
    .from(OC)
    .where(and(eq(OC.nonceHash, sha256(h.nonce)), eq(OC.userId, req.actor!.userId), isNull(OC.completedAt)));
  if (!row)
    throw notFound("CONNECT_NOT_FOUND", "This connection was already used, or isn't yours. Try again.");
  const file = { id: h.file.id, name: String(h.file.name ?? "").slice(0, 200) };
  if (row.targetSourceId) return reconnect(req, d, row.id, row.targetSourceId, h.refreshToken, file);
  await req.db
    .update(OC)
    .set({
      grantEnc: d.keyring.encrypt(h.refreshToken, `oauth-connect:${row.id}`),
      fileId: file.id,
      fileName: file.name,
      completedAt: new Date(),
    })
    .where(eq(OC.id, row.id));
  await audit(req, {
    action: "sheet.google_connected",
    entityType: "integration",
    diff: { file: file.name },
  });
  return { connectId: row.id, file };
}

/** "Connect again": the same file, a new grant; the sheet reads again at once. */
async function reconnect(
  req: FastifyRequest,
  d: AppDeps,
  connectId: string,
  sourceId: string,
  refreshToken: string,
  file: { id: string; name: string },
) {
  const s = await liveSource(req, sourceId);
  const cfg = openConfig(d.keyring, s.id, s.configEnc!);
  if (cfg.spreadsheetId !== file.id)
    throw new HttpError(
      409,
      "CONNECT_WRONG_FILE",
      `That's a different file. Pick the sheet “${s.name}” was connected to.`,
    );
  await req.db
    .update(S)
    .set({
      configEnc: sealConfig(d.keyring, s.id, { ...cfg, auth: "oauth", grant: refreshToken }),
      ...(s.status === "needs_attention" ? { status: "active", attentionCode: null, lastError: null } : {}),
      nextSyncAt: new Date(),
    })
    .where(eq(S.id, s.id));
  await req.db.delete(schema.oauthConnects).where(eq(schema.oauthConnects.id, connectId));
  await audit(req, {
    action: "sheet.reconnected",
    entityType: "lead_source",
    entityId: s.id,
    diff: { name: s.name },
  });
  const r = await requestSync(req.db, { sourceId: s.id, trigger: "manual", requestedBy: req.actor!.userId });
  if (r?.fresh) req.afterCommit(() => void d.sheets?.enqueue(r.syncId));
  return { reconnected: s.id, file };
}

/** A finished connect of the caller's: its grant, the picked file, and a client that reads with it. */
async function grantOf(req: FastifyRequest, d: AppDeps, connectId: string) {
  const OC = schema.oauthConnects;
  const [row] = await req.db
    .select()
    .from(OC)
    .where(and(eq(OC.id, connectId), eq(OC.userId, req.actor!.userId)));
  if (!row?.grantEnc || !row.fileId)
    throw notFound("CONNECT_NOT_FOUND", "This connection was already used, or isn't yours. Try again.");
  const refreshToken = d.keyring.decrypt(row.grantEnc, `oauth-connect:${row.id}`);
  const client = oauthClientFor(d.googleOAuth, d.googleEndpoint)({ grant: refreshToken });
  if (!client) throw new HttpError(409, "NOT_CONFIGURED", "Connect with Google isn't set up on this server.");
  return { refreshToken, fileId: row.fileId, fileName: row.fileName ?? "", client };
}

// ——— Connecting (spec §7.2) ———

/** The service account's client, for the paste-a-link path; that path needs a key on this server. */
function serviceAccount(d: AppDeps): GoogleSheets {
  if (!d.google)
    throw new HttpError(
      409,
      "NOT_CONFIGURED",
      "This server has no Google key for shared sheets. Use Connect with Google.",
    );
  return d.google;
}

export async function inspectSheet(
  req: FastifyRequest,
  d: AppDeps,
  body: { link: string } | { connectId: string },
) {
  await requireOn(req, d);
  if ("connectId" in body) {
    const g = await grantOf(req, d, body.connectId);
    const meta = await fromGoogle(g.client, () => g.client.spreadsheet(g.fileId));
    return {
      spreadsheetId: g.fileId,
      title: meta.title,
      gid: null,
      tabs: meta.tabs.map(({ sheetId, title }) => ({ sheetId, title })),
      email: "",
    };
  }
  const google = serviceAccount(d);
  const link = body.link;
  const parsed = parseSheetLink(link);
  if (!parsed)
    throw badRequest(
      "LINK_INVALID",
      "That doesn't look like a Google Sheets link. Copy it from the sheet's address bar.",
    );
  const meta = await fromGoogle(google, () => google.spreadsheet(parsed.spreadsheetId));
  return {
    spreadsheetId: parsed.spreadsheetId,
    title: meta.title,
    gid: parsed.gid,
    tabs: meta.tabs.map(({ sheetId, title }) => ({ sheetId, title })),
    email: google.email,
  };
}

/** The first rows of a tab as a CSV the 2A reader understands, padded to one width (no "ragged rows"). */
async function snapshot(google: GoogleSheets, cfg: Pick<SheetConfig, "spreadsheetId" | "sheetId">) {
  const meta = await fromGoogle(google, () => google.spreadsheet(cfg.spreadsheetId));
  const tab = meta.tabs.find((t) => t.sheetId === cfg.sheetId);
  if (!tab) throw new HttpError(409, "TAB_NOT_FOUND", "That tab isn't in the spreadsheet any more.");
  const [rows = []] = await fromGoogle(google, () =>
    google.values(cfg.spreadsheetId, [rowsRange(tab.title, 1, SNAPSHOT_ROWS)]),
  );
  if (!rows.some((r) => r.some((c) => c.trim()))) throw badRequest("SHEET_EMPTY", "This tab is empty.");
  const width = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => [...r, ...Array<string>(width - r.length).fill("")]);
  return { meta, tab, bytes: Buffer.from(gridToCsv(grid), "utf8"), moreRows: rows.length >= SNAPSHOT_ROWS };
}

export type SheetDraft = {
  draft: DraftView;
  sheet: {
    title: string;
    name: string;
    tabTitle: string;
    email: string;
    moreRows: boolean;
    editing: string | null;
    /** When editing, the sheet's own check interval, so saving doesn't change it (final review, 9). */
    pollSeconds: number;
  };
};

/**
 * Amendment A1: a sheet is set up with the 2A draft (Columns, Rules, Preview). A new sheet's draft source
 * becomes the sheet on save; an edit's draft sits on a throwaway source and names the live one.
 */
export async function createSheetDraft(
  req: FastifyRequest,
  d: AppDeps,
  body:
    | { link: string; sheetId: number; headerRow?: number }
    | { sourceId: string }
    | { connectId: string; sheetId: number; headerRow?: number },
): Promise<SheetDraft> {
  await requireOn(req, d);
  let google: GoogleSheets | null = null;
  let connectId: string | null = null;
  if (!can(req.actor!, "leads.import"))
    throw forbidden("CANNOT_IMPORT", "Connecting a sheet adds leads, which your role can't do.");
  let cfg: SheetConfig;
  let target: Source | null = null;
  if ("sourceId" in body) {
    target = await liveSource(req, body.sourceId);
    if (!canSeeRows(req, target)) throw rowsHidden();
    cfg = openConfig(d.keyring, target.id, target.configEnc!);
    google = cfg.auth === "oauth" ? oauthClientFor(d.googleOAuth, d.googleEndpoint)(cfg) : serviceAccount(d);
    if (!google)
      throw new HttpError(409, "NOT_CONFIGURED", "Connect with Google isn't set up on this server any more.");
  } else if ("connectId" in body) {
    // A file picked with Connect with Google (2B-2): read with its own grant, which the sheet keeps.
    const g = await grantOf(req, d, body.connectId);
    google = g.client;
    connectId = body.connectId;
    cfg = {
      spreadsheetId: g.fileId,
      sheetId: body.sheetId,
      tabTitle: "",
      headerRow: body.headerRow ?? 0,
      auth: "oauth",
      grant: g.refreshToken,
    };
  } else {
    google = serviceAccount(d);
    const parsed = parseSheetLink(body.link);
    if (!parsed)
      throw badRequest(
        "LINK_INVALID",
        "That doesn't look like a Google Sheets link. Copy it from the sheet's address bar.",
      );
    cfg = {
      spreadsheetId: parsed.spreadsheetId,
      sheetId: body.sheetId,
      tabTitle: "",
      headerRow: body.headerRow ?? 0,
      auth: "service_account",
    };
  }
  const snap = await snapshot(google!, cfg);
  const sourceId = newId();
  await req.db.insert(S).values({
    id: sourceId,
    type: "google_sheet",
    name: target?.name ?? snap.meta.title,
    status: "draft",
    createdBy: req.actor!.userId,
  });
  const draft = await createDraftFrom(req, d, {
    bytes: snap.bytes,
    fileName: `${snap.meta.title} — ${snap.tab.title}`,
    kind: "sheet",
    sourceId,
    ...(cfg.headerRow ? { headerRow: cfg.headerRow } : {}),
    ...(target
      ? { mapping: target.mapping as Mapping, rules: target.rules as Rules, targetSourceId: target.id }
      : {}),
  });
  await req.db
    .update(S)
    .set({
      configEnc: sealConfig(d.keyring, sourceId, {
        ...cfg,
        tabTitle: snap.tab.title,
        headerRow: draft.headerRow,
      }),
    })
    .where(eq(S.id, sourceId));
  // The connect stays until the sheet is saved (going back a step drafts again); the daily sweep ends it.
  void connectId;
  return {
    draft,
    sheet: {
      title: snap.meta.title,
      name: target?.name ?? snap.meta.title,
      tabTitle: snap.tab.title,
      email: google!.email,
      moreRows: snap.moreRows,
      editing: target?.id ?? null,
      pollSeconds: target?.pollSeconds ?? 120,
    },
  };
}

/** A sheet source that isn't a draft or removed; others are 404. */
async function liveSource(req: FastifyRequest, id: string): Promise<Source> {
  const [s] = await req.db
    .select()
    .from(S)
    .where(and(eq(S.id, id), eq(S.type, "google_sheet")));
  if (!s || s.status === "draft" || s.status === "archived")
    throw notFound("SHEET_NOT_FOUND", "Sheet not found");
  return s;
}

export async function saveSheet(
  req: FastifyRequest,
  d: AppDeps,
  body: { importId: string; name: string; pollSeconds: number; startFrom: "all" | "new" },
): Promise<{ view: SheetSourceView; created: boolean }> {
  await requireOn(req, d);
  const actor = req.actor!;
  await req.db.execute(sql`SELECT 1 FROM imports WHERE id = ${body.importId} FOR UPDATE`);
  const imp = await mine(req, body.importId);
  if (imp.kind !== "sheet" || imp.status !== "draft")
    throw new HttpError(409, "NOT_DRAFT", "This sheet was already saved.");
  if (!can(actor, "leads.import"))
    throw forbidden("CANNOT_IMPORT", "Connecting a sheet adds leads, which your role can't do.");
  const { file, mapping, rules, columnSettings } = await prepareStart(req, d, imp, {
    keepCreatingTags: true,
  });
  if (givesAway(rules, mapping, actor) && !can(actor, "leads.assign"))
    throw forbidden("CANNOT_ASSIGN", "This sheet gives leads to other people, which your role can't do.");
  const [draftSrc] = await req.db.select().from(S).where(eq(S.id, imp.sourceId));
  const cfg = { ...openConfig(d.keyring, draftSrc!.id, draftSrc!.configEnc!), headerRow: imp.headerRow ?? 1 };
  const shared = {
    name: body.name.trim(),
    pollSeconds: body.pollSeconds,
    mapping,
    rules,
    columnSettings,
    headers: file.headers,
    runAs: actor.userId,
    nextSyncAt: new Date(),
    newColumns: [] as string[],
  };

  let sourceId: string;
  if (imp.targetSourceId) {
    // Editing a live sheet: it takes the new columns and rules, runs as whoever saved, and reads afresh.
    const target = await liveSource(req, imp.targetSourceId);
    // If the edit changes how rows are recognised, rows already read are recognised again, not re-imported.
    const before = openConfig(d.keyring, target.id, target.configEnc!);
    const rekeyed =
      identityKey(target.mapping as Mapping, target.headers.length) !==
      identityKey(mapping, file.headers.length);
    await req.db
      .update(S)
      .set({
        ...shared,
        configEnc: sealConfig(d.keyring, target.id, cfg),
        configVersion: target.configVersion + 1,
        status: target.status === "needs_attention" ? "active" : target.status,
        attentionCode: null,
        lastError: null,
        headHash: null,
        rekeyThrough: rekeyed ? before.headerRow + target.rowsRead : target.rekeyThrough,
      })
      .where(eq(S.id, target.id));
    await req.db.delete(S).where(eq(S.id, draftSrc!.id)); // the throwaway source, and its draft with it
    await audit(req, {
      action: "sheet.mapping_changed",
      entityType: "lead_source",
      entityId: target.id,
      diff: { name: shared.name },
    });
    sourceId = target.id;
  } else {
    await assertNotConnected(req, d, cfg);
    await req.db
      .update(S)
      .set({
        ...shared,
        status: "active",
        configEnc: sealConfig(d.keyring, draftSrc!.id, cfg),
        baseline: body.startFrom === "new",
      })
      .where(eq(S.id, draftSrc!.id));
    await req.db.delete(I).where(eq(I.id, imp.id));
    // Made from a file picked with Connect with Google: that connect is done with now.
    if (cfg.auth === "oauth")
      await req.db
        .delete(schema.oauthConnects)
        .where(
          and(
            eq(schema.oauthConnects.userId, actor.userId),
            eq(schema.oauthConnects.fileId, cfg.spreadsheetId),
          ),
        );
    await audit(req, {
      action: "sheet.connected",
      entityType: "lead_source",
      entityId: draftSrc!.id,
      diff: { name: shared.name, startFrom: body.startFrom },
    });
    sourceId = draftSrc!.id;
  }
  const r = await requestSync(req.db, { sourceId, trigger: "connect", requestedBy: actor.userId });
  if (r?.fresh) req.afterCommit(() => void d.sheets?.enqueue(r.syncId));
  return { view: await sourceView(req, d, await liveSource(req, sourceId)), created: !imp.targetSourceId };
}

async function assertNotConnected(req: FastifyRequest, d: AppDeps, cfg: SheetConfig) {
  const others = await req.db
    .select({ id: S.id, name: S.name, configEnc: S.configEnc })
    .from(S)
    .where(and(eq(S.type, "google_sheet"), inArray(S.status, ["active", "paused", "needs_attention"])));
  if (others.length >= MAX_SHEETS)
    throw new HttpError(
      409,
      "TOO_MANY_SHEETS",
      `LUME reads up to ${MAX_SHEETS} sheets. Remove one to add another.`,
    );
  const same = others.find((o) => {
    const c = openConfig(d.keyring, o.id, o.configEnc!);
    return c.spreadsheetId === cfg.spreadsheetId && c.sheetId === cfg.sheetId;
  });
  if (same)
    throw new HttpError(409, "SHEET_ALREADY_CONNECTED", `This tab is already connected as “${same.name}”.`);
}

/**
 * A sheet's raw rows (problem cells, the edit preview) show contacts. As 2A's report: only the person it runs
 * as, whoever connected it, or someone who sees every lead's full contact may see them (final review, 8).
 */
function canSeeRows(req: FastifyRequest, s: Source): boolean {
  const a = req.actor!;
  return (
    s.runAs === a.userId ||
    s.createdBy === a.userId ||
    (can(a, "leads.view", "all") && can(a, "leads.contact.full"))
  );
}
const rowsHidden = () =>
  new HttpError(
    403,
    "ROWS_HIDDEN",
    "Only the person this sheet runs as, or someone who can see every lead's contact details, can see its rows.",
  );

// ——— Looking after a sheet (spec §7.1, §7.3) ———

export type SheetSourceView = Awaited<ReturnType<typeof sourceView>>;

async function sourceView(req: FastifyRequest, d: AppDeps, s: Source) {
  const cfg = openConfig(d.keyring, s.id, s.configEnc!);
  const { rows } = await req.db.execute<{
    today: number;
    all: number;
    problems: number;
    run_as: string | null;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE result = 'created' AND first_seen_at >= (date_trunc('day', now() AT TIME ZONE st.timezone) AT TIME ZONE st.timezone))::int AS today,
      count(*) FILTER (WHERE result = 'created')::int AS all,
      count(*) FILTER (WHERE result = 'error')::int AS problems,
      (SELECT name FROM users WHERE id = ${s.runAs}) AS run_as
    FROM settings st LEFT JOIN source_rows sr ON sr.source_id = ${s.id}
    WHERE st.id = 1`);
  const c = rows[0]!;
  return {
    id: s.id,
    name: s.name,
    status: s.status as "active" | "paused" | "needs_attention",
    attention:
      s.status === "needs_attention" ? { code: s.attentionCode ?? "", message: s.lastError ?? "" } : null,
    tabTitle: cfg.tabTitle,
    link: `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}/edit#gid=${cfg.sheetId}`,
    pollSeconds: s.pollSeconds,
    lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
    nextSyncAt: s.status === "active" ? (s.nextSyncAt?.toISOString() ?? null) : null,
    syncing: s.currentSyncId !== null,
    // Three failed syncs in a row: the page warns (spec §5.4); one or two pass quietly.
    failing: s.status === "active" && s.failures >= 3,
    lastError: s.status === "active" ? s.lastError : null,
    newColumns: s.newColumns,
    newToday: c.today,
    newAllTime: c.all,
    problems: c.problems,
    runAs: s.runAs && c.run_as ? { id: s.runAs, name: c.run_as } : null,
    auth: cfg.auth,
    canSeeRows: canSeeRows(req, s),
  };
}

export async function listSheets(req: FastifyRequest, d: AppDeps) {
  const rows = await req.db
    .select()
    .from(S)
    .where(and(eq(S.type, "google_sheet"), inArray(S.status, ["active", "paused", "needs_attention"])))
    .orderBy(asc(S.createdAt));
  // One after another: they share this request's connection, which runs one query at a time.
  const sources = [];
  for (const s of rows) sources.push(await sourceView(req, d, s));
  return { sources };
}

export async function getSheet(req: FastifyRequest, d: AppDeps, id: string) {
  const s = await liveSource(req, id);
  const syncs = await req.db
    .select()
    .from(SY)
    .where(eq(SY.sourceId, id))
    .orderBy(desc(SY.requestedAt))
    .limit(10);
  const problemRows = await req.db
    .select({ id: SR.id, rowNumber: SR.rowNumber, problems: SR.problems, lastTriedAt: SR.lastTriedAt })
    .from(SR)
    .where(and(eq(SR.sourceId, id), eq(SR.result, "error")))
    .orderBy(asc(SR.rowNumber))
    .limit(100);
  return {
    ...(await sourceView(req, d, s)),
    syncs: syncs.map((x): SyncView => ({
      id: x.id,
      trigger: x.trigger,
      status: x.status,
      startedAt: x.startedAt?.toISOString() ?? null,
      finishedAt: x.finishedAt?.toISOString() ?? null,
      created: x.created,
      merged: x.merged,
      errors: x.errors,
      error: x.error,
    })),
    problemRows: problemRows.map((p): ProblemRowView => ({
      id: p.id,
      rowNumber: p.rowNumber,
      problems: (p.problems as { code: string; message: string }[]).map(({ code, message }) => ({
        code,
        message,
      })),
      lastTriedAt: p.lastTriedAt.toISOString(),
    })),
  };
}

export async function patchSheet(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  p: { name?: string; pollSeconds?: number; paused?: boolean },
) {
  const s = await liveSource(req, id);
  const set: Partial<typeof S.$inferInsert> = {};
  if (p.name !== undefined) set.name = p.name.trim();
  if (p.pollSeconds !== undefined) set.pollSeconds = p.pollSeconds;
  // Pausing lets go of a sync under way, which stops it within 25 rows (sync.ts).
  if (p.paused === true && s.status === "active")
    Object.assign(set, { status: "paused", currentSyncId: null, syncLockUntil: null });
  if (p.paused === false && s.status === "paused")
    Object.assign(set, { status: "active", nextSyncAt: new Date() });
  if (Object.keys(set).length) await req.db.update(S).set(set).where(eq(S.id, id));
  if (set.status)
    await audit(req, {
      action: set.status === "paused" ? "sheet.paused" : "sheet.resumed",
      entityType: "lead_source",
      entityId: id,
      diff: { name: s.name },
    });
  return sourceView(req, d, await liveSource(req, id));
}

/** Amendment A12: removed is archived; its leads keep it, so "From …" still reads right. */
export async function removeSheet(req: FastifyRequest, id: string) {
  const s = await liveSource(req, id);
  await req.db
    .update(S)
    .set({ status: "archived", archivedAt: new Date(), currentSyncId: null, syncLockUntil: null })
    .where(eq(S.id, id));
  await audit(req, {
    action: "sheet.removed",
    entityType: "lead_source",
    entityId: id,
    diff: { name: s.name },
  });
}

/** Sync now, or, for a sheet that lost access or its tab, "Test again" (it's active again if it works). */
export async function syncNow(req: FastifyRequest, d: AppDeps, id: string) {
  await requireOn(req, d);
  const s = await liveSource(req, id);
  if (s.status === "paused") throw new HttpError(409, "NOT_ACTIVE", "This sheet is paused. Resume it first.");
  if (s.status === "needs_attention") {
    if (!RETRYABLE.has(s.attentionCode ?? ""))
      throw new HttpError(409, "NEEDS_EDIT", "Open this sheet's columns and save them first.");
    await req.db
      .update(S)
      .set({ status: "active", attentionCode: null, lastError: null })
      .where(eq(S.id, id));
  }
  const r = await requestSync(req.db, { sourceId: id, trigger: "manual", requestedBy: req.actor!.userId });
  if (r?.fresh) req.afterCommit(() => void d.sheets?.enqueue(r.syncId));
  return { syncId: r?.syncId ?? null };
}

export async function dismissRow(req: FastifyRequest, id: string, rowId: number) {
  const s = await liveSource(req, id);
  const gone = await req.db
    .update(SR)
    .set({ result: "dismissed", rawEnc: null })
    .where(and(eq(SR.id, rowId), eq(SR.sourceId, id), eq(SR.result, "error")))
    .returning({ id: SR.id });
  if (!gone.length) throw notFound("ROW_NOT_FOUND", "That problem row isn't there any more.");
  await audit(req, {
    action: "sheet.row_dismissed",
    entityType: "lead_source",
    entityId: id,
    diff: { name: s.name },
  });
}

/** Problem rows as a CSV that opens cleanly in Excel (BOM, CRLF, no live formulas), as 2A's report. */
export async function problemsCsv(req: FastifyRequest, d: AppDeps, id: string) {
  const s = await liveSource(req, id);
  if (!canSeeRows(req, s)) throw rowsHidden();
  const rows = await req.db
    .select()
    .from(SR)
    .where(and(eq(SR.sourceId, id), eq(SR.result, "error")))
    .orderBy(asc(SR.rowNumber));
  const data = rows.map((r) => {
    const cells = r.rawEnc
      ? (JSON.parse(d.keyring.decrypt(r.rawEnc, `sheet-row:${id}:${r.fingerprint}`)) as string[])
      : [];
    const why = (r.problems as { message: string }[]).map((p) => p.message).join(" ");
    return [String(r.rowNumber), why, ...cells].map((c) => safeCell(c));
  });
  const table = Papa.unparse([["Row", "Problem", ...s.headers], ...data], { newline: "\r\n" });
  return { fileName: `${s.name} — problem rows.csv`, body: `${String.fromCharCode(0xfeff)}${table}\r\n` };
}
