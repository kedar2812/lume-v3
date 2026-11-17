import { and, desc, eq, exists, gte, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  countryOfPhone,
  metaColumns,
  seesFullContacts,
  splitName,
  type LiveSheetPreset,
  type LiveSheetRule,
  type SheetCell,
  type SheetRow,
} from "@lume/core";
import { schema } from "@lume/db";
import { loadFieldRegistry } from "../../leads/fields";
import { columnsFor, type Lookups } from "../lead-exports/make";
import { scopeCondition, tagsFor } from "../leads/query";
import { serializeLead } from "../leads/serialize";

/**
 * Which leads a live sheet holds and what each row says (spec 2026-11-14 §2, §4), read as the person it runs as: their
 * reach (row-level security and scopeCondition) and their field access (columnsFor never gives a hidden field).
 */
const L = schema.leads;
/** Most leads one sheet holds: the newest, when more match (10 million cells is Google's limit for a spreadsheet). */
export const ROWS_MAX = 100_000;

export type SheetSpec = {
  preset: LiveSheetPreset;
  rule: LiveSheetRule;
  columns: string[];
  createdAt: Date;
};

export async function businessTz(req: FastifyRequest): Promise<string> {
  const [s] = await req.db.select({ tz: schema.settings.timezone }).from(schema.settings);
  return s?.tz ?? "UTC";
}

/** The rule as conditions on leads (deleted ones never). */
export function ruleConditions(req: FastifyRequest, spec: SheetSpec, tz: string): SQL[] {
  const r = spec.rule;
  const ids = r.stages.stageIds;
  const H = schema.leadStageHistory;
  const reachedEver = exists(
    req.db
      .select({ one: sql`1` })
      .from(H)
      .where(and(eq(H.leadId, L.id), inArray(H.toStageId, ids))),
  );
  const out: SQL[] = [isNull(L.deletedAt)];
  const scope = scopeCondition(req);
  if (scope) out.push(scope);
  out.push(r.stages.mode === "in" ? inArray(L.stageId, ids) : or(inArray(L.stageId, ids), reachedEver)!);
  if (r.sourceIds?.length) out.push(inArray(L.sourceId, r.sourceIds));
  if (r.ownerIds?.length) out.push(inArray(L.ownerId, r.ownerIds));
  if (r.teamIds?.length)
    out.push(
      inArray(
        L.ownerId,
        req.db
          .select({ id: schema.teamMembers.userId })
          .from(schema.teamMembers)
          .where(inArray(schema.teamMembers.teamId, r.teamIds)),
      ),
    );
  if (r.tagIds?.length)
    out.push(
      exists(
        req.db
          .select({ one: sql`1` })
          .from(schema.leadTags)
          .where(and(eq(schema.leadTags.leadId, L.id), inArray(schema.leadTags.tagId, r.tagIds))),
      ),
    );
  if (r.addedOnOrAfter)
    out.push(sql`${L.createdAt} >= (${r.addedOnOrAfter}::date::timestamp AT TIME ZONE ${tz})`);
  if (!r.includeDnc) out.push(isNull(L.dncAt));
  // Only leads that matched after the sheet was made: they arrived, or moved into one of its stages, since.
  if (!r.backfill) {
    const since = spec.createdAt;
    out.push(
      or(
        gte(L.createdAt, since),
        and(inArray(L.stageId, ids), gte(L.stageEnteredAt, since)),
        exists(
          req.db
            .select({ one: sql`1` })
            .from(H)
            .where(and(eq(H.leadId, L.id), inArray(H.toStageId, ids), gte(H.changedAt, since))),
        ),
      )!,
    );
  }
  return out;
}

/** A lead Meta can match: an email, or a phone LUME could read with its country. */
const contactable = or(isNotNull(L.email), isNotNull(L.phoneE164))!;

/** How many leads the rule holds today, and how many of them have no phone and no email (the form's count). */
export async function countRule(
  req: FastifyRequest,
  spec: Omit<SheetSpec, "columns">,
): Promise<{ matching: number; missingContact: number }> {
  const tz = await businessTz(req);
  const where = ruleConditions(req, { ...spec, columns: [] }, tz);
  const [row] = await req.db
    .select({
      all: sql<number>`count(*)::int`,
      missing: sql<number>`count(*) FILTER (WHERE ${L.email} IS NULL AND ${L.phoneE164} IS NULL)::int`,
    })
    .from(L)
    .where(and(...where));
  const missingContact = row?.missing ?? 0;
  const all = row?.all ?? 0;
  return {
    matching: spec.preset === "meta" && !spec.rule.includeMissing ? all - missingContact : all,
    missingContact,
  };
}

export type Desired = {
  header: string[];
  rows: SheetRow[];
  /** More matched than a sheet holds; the newest are kept. */
  capped: boolean;
  /** Whether the person it runs as sees phones and emails in full (a sheet with contacts needs it). */
  contactsFull: boolean;
  /** Whether any column carries a phone or an email. */
  hasContacts: boolean;
};

/** The sheet's header and rows today, newest lead first. */
export async function desiredRows(req: FastifyRequest, spec: SheetSpec): Promise<Desired> {
  const tz = await businessTz(req);
  const where = ruleConditions(req, spec, tz);
  if (spec.preset === "meta" && !spec.rule.includeMissing) where.push(contactable);
  const stageRows = await req.db
    .select({ id: schema.stages.id, name: schema.stages.name, kind: schema.stages.kind })
    .from(schema.stages);
  const won = new Set(stageRows.filter((s) => s.kind === "won").map((s) => s.id));
  const contactsFull = seesFullContacts(req.actor!);
  const rows = await req.db
    .select()
    .from(L)
    .where(and(...where))
    .orderBy(desc(L.createdAt), desc(L.id))
    .limit(ROWS_MAX + 1);
  const capped = rows.length > ROWS_MAX;
  const leads = capped ? rows.slice(0, ROWS_MAX) : rows;

  if (spec.preset === "meta") {
    const includesWon = spec.rule.stages.stageIds.some((id) => won.has(id));
    const header = metaColumns(includesWon);
    return {
      header,
      capped,
      contactsFull,
      hasContacts: true,
      rows: leads.map((l) => {
        const digits = l.phoneE164 ? l.phoneE164.replace(/\D/g, "") : "";
        const { fn, ln } = splitName(l.name);
        const cells: SheetCell[] = [
          l.email ? String(l.email).trim().toLowerCase() : null,
          digits || null,
          fn || null,
          ln || null,
          digits ? (countryOfPhone(digits) ?? l.phoneCountryIso ?? null) : null,
        ];
        if (includesWon) cells.push(won.has(l.stageId) && l.value != null ? Number(l.value) : null);
        return { leadId: l.id, cells };
      }),
    };
  }

  const fields = await loadFieldRegistry(req);
  const columns = columnsFor(req, spec.columns, fields);
  const tagsOf = await tagsFor(
    req,
    leads.map((l) => l.id),
  );
  const [people, tags] = await Promise.all([
    req.db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users),
    req.db.select({ id: schema.tags.id, name: schema.tags.label }).from(schema.tags),
  ]);
  const lookups: Lookups = {
    stages: new Map(stageRows.map((s) => [s.id, s.name])),
    people: new Map(people.map((p) => [p.id, p.name])),
    tags: new Map(tags.map((t) => [t.id, t.name])),
    tz,
  };
  const ctx = { actor: req.actor!, fields };
  return {
    header: columns.map((c) => c.header),
    capped,
    contactsFull,
    hasContacts: columns.some((c) => c.contact === "email" || c.contact === "phone"),
    rows: leads.map((l) => {
      const v = serializeLead(l, { ...ctx, tagIds: tagsOf.get(l.id) ?? [] });
      return { leadId: l.id, cells: columns.map((c) => c.cell(v, lookups)) };
    }),
  };
}

/** Of these leads, the ones still in LUME and in reach of the person the sheet runs as. */
export async function stillThere(
  req: FastifyRequest,
  ids: string[],
  /** The rule leaves out do-not-contact leads: one marked since it went in has to leave too (bug hunt 2026-11-17). */
  dropDnc = false,
): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 10_000) {
    const slice = ids.slice(i, i + 10_000);
    const scope = scopeCondition(req);
    const rows = await req.db
      .select({ id: L.id })
      .from(L)
      .where(
        and(
          inArray(L.id, slice),
          isNull(L.deletedAt),
          ...(dropDnc ? [isNull(L.dncAt)] : []),
          ...(scope ? [scope] : []),
        ),
      );
    for (const r of rows) out.add(r.id);
  }
  return out;
}
