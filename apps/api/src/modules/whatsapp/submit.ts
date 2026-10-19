import { readFile } from "node:fs/promises";
import {
  metaCategoryOf,
  metaNameOf,
  newId,
  templateProblems,
  templateReasonWords,
  toMetaTemplate,
  type HeaderKind,
  type MetaCategory,
  type WaTemplateEvent,
} from "@lume/core";
import { schema } from "@lume/db";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, notFound } from "../../http/errors";
import { adminIds, notify } from "../notifications/notify";
import { MetaError, metaClient } from "./meta";
import { relayOf, tokenContext } from "./service";

const S = schema.whatsappTemplateSubmissions;
const N = schema.whatsappNumbers;
const T = schema.messageTemplates;
const V = schema.templateVersions;
const F = schema.messageFiles;

export type SubmissionStatus = (typeof S.$inferSelect)["status"];
export type SubmissionView = {
  id: string;
  versionId: string;
  /** Whether it's the template's words as they are now: an edit after approval needs approving again. */
  current: boolean;
  /** The WhatsApp numbers it covers (one business account), by how they show. */
  account: string;
  language: string;
  category: MetaCategory;
  status: SubmissionStatus;
  /** Why it was turned down or couldn't go, in LUME's words. */
  reason: string | null;
  submittedAt: string;
  decidedAt: string | null;
};

/** WhatsApp's word on a template as LUME's: what can be sent (approved), what waits, and what can't. */
export function statusOf(meta: string): SubmissionStatus {
  switch (meta.toUpperCase()) {
    case "APPROVED":
    case "FLAGGED": // still sendable while WhatsApp watches its quality
    case "REINSTATED":
      return "approved";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "DISABLED":
    case "PENDING_DELETION":
    case "DELETED":
    case "ARCHIVED":
      return "disabled";
    default: // PENDING, IN_APPEAL, and anything new: still with WhatsApp
      return "pending";
  }
}

const conflict = (code: string, message: string) => new HttpError(409, code, message);
const VOICE_AT_TOP = "A voice note can't go at the top of a template. Choose a photo, a video or a PDF.";

/** Every submission of a template (all its versions), newest first, as the template's WhatsApp panel shows them. */
export async function submissionsOf(
  req: FastifyRequest,
  d: AppDeps,
  templateId: string,
): Promise<{ on: boolean; submissions: SubmissionView[] }> {
  const [t] = await req.db.select({ current: T.currentVersionId }).from(T).where(eq(T.id, templateId));
  if (!t) throw notFound();
  const rows = await req.db
    .select({ s: S })
    .from(S)
    .innerJoin(V, eq(V.id, S.templateVersionId))
    .where(eq(V.templateId, templateId))
    .orderBy(desc(S.submittedAt), desc(S.id));
  const wabas = [...new Set(rows.map((r) => r.s.wabaId))];
  const numbers = wabas.length
    ? await req.db
        .select({ waba: N.wabaId, display: N.displayPhone })
        .from(N)
        .where(and(inArray(N.wabaId, wabas), ne(N.status, "disconnected")))
        .orderBy(asc(N.displayPhone))
    : [];
  const accountOf = (waba: string) =>
    numbers
      .filter((n) => n.waba === waba)
      .map((n) => n.display)
      .join(", ") || "A WhatsApp account no longer connected";
  // Whether a template can go to WhatsApp here at all: WhatsApp set up, switched on, with a connected number. The
  // template's panel hides where it can't (an optional integration).
  const [settings] = await req.db
    .select({ i: schema.settings.integrations })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  const [active] = await req.db.select({ id: N.id }).from(N).where(eq(N.status, "active")).limit(1);
  const on = !!d.meta && !!relayOf(d) && !!settings?.i.whatsapp?.enabled && !!active;
  return {
    on,
    submissions: rows.map(({ s }) => ({
      id: s.id,
      versionId: s.templateVersionId,
      current: s.templateVersionId === t.current,
      account: accountOf(s.wabaId),
      language: s.language,
      category: s.category,
      status: s.status,
      reason: s.status === "rejected" ? templateReasonWords(s.reason) : s.reason,
      submittedAt: s.submittedAt.toISOString(),
      decidedAt: s.decidedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Send a template's current words to WhatsApp for approval (W3b-2 Task 4), once for each WhatsApp business account
 * with a connected number. What WhatsApp would turn down is said first, in LUME's words, and nothing goes. A file at the
 * top comes from the library and goes up once as the sample WhatsApp reviews.
 */
export async function submitTemplate(
  req: FastifyRequest,
  d: AppDeps,
  templateId: string,
  input: { language: string; category?: MetaCategory | undefined; headerFileId?: string | undefined },
): Promise<{ on: boolean; submissions: SubmissionView[] }> {
  if (!d.meta || !relayOf(d)) throw conflict("WHATSAPP_OFF", "WhatsApp isn't set up on this server yet.");
  const [t] = await req.db
    .select({
      id: T.id,
      name: T.name,
      category: T.category,
      versionId: T.currentVersionId,
      body: V.body,
      versionAt: V.createdAt,
    })
    .from(T)
    .innerJoin(V, eq(V.id, T.currentVersionId))
    .where(and(eq(T.id, templateId), isNull(T.archivedAt)));
  if (!t?.versionId) throw notFound();

  let header: { kind: HeaderKind; mime: string; size: number; name: string; sha256: string } | null = null;
  if (input.headerFileId) {
    const [f] = await req.db
      .select({ kind: F.kind, mime: F.mime, size: F.size, name: F.name, sha256: F.sha256 })
      .from(F)
      .where(and(eq(F.id, input.headerFileId), isNull(F.archivedAt)));
    if (!f) throw notFound("FILE_NOT_FOUND", "That file isn't in your files any more.");
    if (f.kind === "audio") throw new HttpError(422, "TEMPLATE_PROBLEMS", VOICE_AT_TOP, [VOICE_AT_TOP]);
    header = { ...f, kind: f.kind };
  }
  const problems = templateProblems(t.body, header ?? undefined);
  if (problems.length)
    throw new HttpError(422, "TEMPLATE_PROBLEMS", "WhatsApp would turn this template down.", problems);
  if (header && !d.meta.appId)
    throw conflict(
      "META_APP_MISSING",
      "A file at the top needs LUME's Meta app on this server (LUME_META_APP_ID). Without a file, it can go now.",
    );

  // One per WhatsApp business account with a connected number, from that account's own token.
  const numbers = await req.db
    .select({ id: N.id, waba: N.wabaId, tokenEnc: N.tokenEnc })
    .from(N)
    .where(eq(N.status, "active"))
    .orderBy(asc(N.id)); // ids are time-ordered: the first connected first
  const accounts = new Map<string, { id: string; tokenEnc: Buffer }>();
  for (const n of numbers)
    if (n.tokenEnc && !accounts.has(n.waba)) accounts.set(n.waba, { id: n.id, tokenEnc: n.tokenEnc });
  if (!accounts.size)
    throw conflict("NO_NUMBER", "Connect a WhatsApp number first, in Settings, under Integrations.");

  const existing = await req.db
    .select({ id: S.id, waba: S.wabaId, status: S.status })
    .from(S)
    .where(and(eq(S.templateVersionId, t.versionId), eq(S.language, input.language)));
  const waiting = new Set(existing.filter((e) => e.status !== "failed").map((e) => e.waba));
  const todo = [...accounts.keys()].filter((w) => !waiting.has(w));
  if (!todo.length) throw conflict("ALREADY_SUBMITTED", "Already with WhatsApp for review.");
  // One that never reached WhatsApp is tried again in its place.
  const stale = existing.filter((e) => e.status === "failed" && todo.includes(e.waba)).map((e) => e.id);
  if (stale.length) await req.db.delete(S).where(inArray(S.id, stale));

  // WhatsApp names each version once: the template's words, its version number, and a few letters of its own id
  // (a template archived and made again under the same name is a different one to WhatsApp).
  const [{ n: version }] = (
    await req.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM template_versions WHERE template_id = ${t.id} AND created_at <= ${t.versionAt}`,
    )
  ).rows as [{ n: number }];
  const metaName = `${metaNameOf(t.name, version).slice(0, 504)}_${t.versionId.replace(/-/g, "").slice(-6)}`;
  const category = input.category ?? metaCategoryOf(t.category);
  const fields = await req.db
    .select({ key: schema.fieldDefinitions.key, type: schema.fieldDefinitions.type })
    .from(schema.fieldDefinitions);

  let handle: string | null = null;
  for (const waba of todo) {
    const acct = accounts.get(waba)!;
    const client = metaClient(d.meta, d.keyring.decrypt(acct.tokenEnc, tokenContext(acct.id)));
    const id = newId();
    try {
      if (header && !handle) {
        const bytes = await readFile(d.files!.store.path(header.sha256));
        handle = await client.uploadForTemplate(d.meta.appId!, bytes, header.mime, header.name);
      }
      const { payload, tokens } = toMetaTemplate({
        name: t.name,
        version,
        language: input.language,
        category,
        body: t.body,
        ...(header && handle ? { header: { kind: header.kind, handle } } : {}),
        fields,
      });
      payload.name = metaName;
      await req.db.insert(S).values({
        id,
        templateVersionId: t.versionId,
        wabaId: waba,
        language: input.language,
        category,
        metaName,
        headerFileId: input.headerFileId ?? null,
        tokens,
        status: "submitting",
        submittedBy: req.actor!.userId,
        submittedAt: d.clock(),
      });
      const made = await client.createTemplate(waba, payload);
      await req.db
        .update(S)
        .set({
          metaTemplateId: made.id,
          status: statusOf(made.status),
          ...(made.category === "MARKETING" || made.category === "UTILITY"
            ? { category: made.category }
            : {}),
        })
        .where(eq(S.id, id));
    } catch (e) {
      if (!(e instanceof MetaError) && !(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
      const reason =
        e instanceof MetaError
          ? (e.detail ?? e.message)
          : "The file at the top isn't on this server any more. Choose it again.";
      await req.db
        .insert(S)
        .values({
          id,
          templateVersionId: t.versionId,
          wabaId: waba,
          language: input.language,
          category,
          metaName,
          headerFileId: input.headerFileId ?? null,
          status: "failed",
          reason,
          submittedBy: req.actor!.userId,
          submittedAt: d.clock(),
        })
        .onConflictDoUpdate({ target: S.id, set: { status: "failed", reason } });
    }
  }
  await audit(req, {
    action: "template.submitted",
    entityType: "template",
    entityId: t.id,
    diff: { language: input.language, category, accounts: todo.length },
  });
  return submissionsOf(req, d, t.id);
}

/**
 * WhatsApp's word on templates (by webhook, or the sweep): each submission it names moves to its new status or
 * category. An approval or a rejection tells whoever submitted it and the admins, once: the same word again changes
 * nothing and says nothing.
 */
export async function applyTemplateEvents(pool: pg.Pool, events: WaTemplateEvent[]): Promise<void> {
  for (const ev of events) {
    if (ev.event === "CATEGORY") {
      await pool.query("UPDATE whatsapp_template_submissions SET category = $2 WHERE meta_template_id = $1", [
        ev.templateId,
        ev.category,
      ]);
      continue;
    }
    const status = statusOf(ev.event);
    const { rows } = await pool.query<{ submitted_by: string | null; name: string }>(
      `UPDATE whatsapp_template_submissions s
          SET status = $2, reason = $3, decided_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END
         FROM template_versions v JOIN message_templates t ON t.id = v.template_id
        WHERE s.meta_template_id = $1 AND v.id = s.template_version_id
          AND (s.status IS DISTINCT FROM $2 OR s.reason IS DISTINCT FROM $3)
        RETURNING s.submitted_by, t.name::text AS name`,
      [ev.templateId, status, ev.reason],
    );
    for (const r of rows) {
      if (status !== "approved" && status !== "rejected") continue;
      const title =
        status === "approved" ? `WhatsApp approved “${r.name}”.` : `WhatsApp turned down “${r.name}”.`;
      const body = status === "rejected" ? templateReasonWords(ev.reason) : "It can go to any lead now.";
      const people = new Set([...(r.submitted_by ? [r.submitted_by] : []), ...(await adminIds(pool))]);
      for (const userId of people) await notify(pool, userId, { kind: "template_decided", title, body });
    }
  }
}

/** Pending for this long with no webhook: the sweep asks WhatsApp. */
const SWEEP_AFTER_MS = 10 * 60_000;

/**
 * Templates still with WhatsApp after 10 minutes, asked about by account (a webhook can be lost): every 15 minutes
 * (W3b-2 Task 4), in the API's WhatsApp queue like the rest of WhatsApp's work.
 */
export async function sweepTemplates(
  pool: pg.Pool,
  d: Pick<AppDeps, "meta" | "keyring" | "clock">,
): Promise<void> {
  if (!d.meta) return;
  const { rows } = await pool.query<{
    waba_id: string;
    meta_name: string;
    meta_template_id: string;
    category: string;
  }>(
    `SELECT waba_id, meta_name, meta_template_id, category FROM whatsapp_template_submissions
      WHERE status = 'pending' AND meta_template_id IS NOT NULL AND submitted_at < $1`,
    [new Date(d.clock().getTime() - SWEEP_AFTER_MS)],
  );
  const byWaba = new Map<string, typeof rows>();
  for (const r of rows) byWaba.set(r.waba_id, [...(byWaba.get(r.waba_id) ?? []), r]);
  for (const [waba, subs] of byWaba) {
    const { rows: nums } = await pool.query<{ id: string; token_enc: Buffer }>(
      `SELECT id, token_enc FROM whatsapp_numbers
        WHERE waba_id = $1 AND status = 'active' AND token_enc IS NOT NULL ORDER BY id LIMIT 1`,
      [waba],
    );
    const n = nums[0];
    if (!n) continue;
    const client = metaClient(d.meta, d.keyring.decrypt(n.token_enc, tokenContext(n.id)));
    const found = await client
      .templates(
        waba,
        subs.map((s) => s.meta_name),
      )
      .catch(() => null);
    if (!found) continue;
    const events: WaTemplateEvent[] = [];
    for (const f of found) {
      const s = subs.find((x) => x.meta_template_id === f.id);
      if (!s) continue;
      events.push({ templateId: f.id, event: f.status, reason: f.reason });
      if ((f.category === "MARKETING" || f.category === "UTILITY") && f.category !== s.category)
        events.push({ templateId: f.id, event: "CATEGORY", reason: null, category: f.category });
    }
    await applyTemplateEvents(pool, events);
  }
}
