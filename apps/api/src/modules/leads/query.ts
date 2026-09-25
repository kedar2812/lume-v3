import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { seesFullContacts } from "@lume/core";
import { schema } from "@lume/db";
import { badRequest } from "../../http/errors";
import { loadFieldRegistry, type FieldRegistry } from "../../leads/fields";
import { isFieldVisible, serializeLead, type LeadRow } from "./serialize";

export type ListQuery = {
  cursor?: string;
  limit: number;
  sort: "newest" | "oldest" | "updated" | "name";
  pipelineId?: string;
  stageId?: string; // comma-separated
  ownerId?: string; // uuid | "me" | "none"
  tagId?: string;
  phoneStatus?: "valid" | "needs_country" | "invalid" | "missing";
  q?: string;
  createdFrom?: string;
  createdTo?: string;
  custom?: string; // JSON object: { fieldKey: value }
};

const L = schema.leads;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function encodeCursor(sort: ListQuery["sort"], row: LeadRow): string {
  const v =
    sort === "updated" ? row.updatedAt.toISOString() : sort === "name" ? row.name.toLowerCase() : null;
  return Buffer.from(JSON.stringify([sort, v, row.id])).toString("base64url");
}

function cursorWhere(sort: ListQuery["sort"], cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined;
  let parsed: [string, string | null, string];
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badRequest("BAD_CURSOR", "That cursor isn't valid");
  }
  const [s, v, id] = parsed;
  if (s !== sort || typeof id !== "string") throw badRequest("BAD_CURSOR", "That cursor isn't valid");
  switch (sort) {
    case "newest":
      return lt(L.id, id);
    case "oldest":
      return gt(L.id, id);
    case "updated":
      return sql`(${L.updatedAt}, ${L.id}) < (${v}::timestamptz, ${id}::uuid)`;
    case "name":
      return sql`(lower(${L.name}), ${L.id}) > (${v}, ${id}::uuid)`;
  }
}

const orderBy = (sort: ListQuery["sort"]) =>
  sort === "newest"
    ? [desc(L.id)]
    : sort === "oldest"
      ? [asc(L.id)]
      : sort === "updated"
        ? [desc(L.updatedAt), desc(L.id)]
        : [sql`lower(${L.name}) asc`, asc(L.id)];

export type FilterQuery = Omit<ListQuery, "cursor" | "limit" | "sort">;

/** The WHERE for a set of filters: shared by the list and the board counts, so both always agree. */
export function leadFilters(req: FastifyRequest, q: FilterQuery, fields: FieldRegistry): (SQL | undefined)[] {
  const ctx = { actor: req.actor!, fields };
  const where: (SQL | undefined)[] = [isNull(L.deletedAt)];

  if (q.pipelineId) where.push(eq(L.pipelineId, q.pipelineId));
  if (q.stageId) where.push(inArray(L.stageId, q.stageId.split(",")));
  if (q.ownerId === "me") where.push(eq(L.ownerId, req.actor!.userId));
  else if (q.ownerId === "none") where.push(isNull(L.ownerId));
  else if (q.ownerId) where.push(eq(L.ownerId, q.ownerId));
  if (q.tagId)
    where.push(sql`EXISTS (SELECT 1 FROM lead_tags t WHERE t.lead_id = ${L.id} AND t.tag_id = ${q.tagId})`);
  if (q.phoneStatus) {
    if (!isFieldVisible(ctx, "phone")) throw badRequest("UNKNOWN_FIELD", "Unknown filter");
    where.push(eq(L.phoneStatus, q.phoneStatus));
  }
  if (q.createdFrom) where.push(sql`${L.leadCreatedAt} >= ${q.createdFrom}::date`);
  if (q.createdTo) where.push(sql`${L.leadCreatedAt} <= ${q.createdTo}::date`);

  if (q.q) {
    const term = `%${likeEscape(q.q.trim())}%`;
    const terms: SQL[] = [sql`${L.name} ILIKE ${term}`];
    // Masked roles search names only (report §12.2 #4).
    if (seesFullContacts(req.actor!)) {
      if (isFieldVisible(ctx, "email")) terms.push(sql`${L.email}::text ILIKE ${term}`);
      if (isFieldVisible(ctx, "instagram")) terms.push(sql`${L.instagramHandle}::text ILIKE ${term}`);
      const digits = q.q.replace(/\D/g, "");
      if (digits.length >= 4 && isFieldVisible(ctx, "phone"))
        terms.push(sql`${L.phoneDigits} LIKE ${`%${digits}%`}`);
    }
    where.push(or(...terms));
  }

  if (q.custom) {
    let filter: Record<string, unknown>;
    try {
      filter = JSON.parse(q.custom);
    } catch {
      throw badRequest("BAD_FILTER", "custom must be a JSON object");
    }
    if (typeof filter !== "object" || filter === null || Array.isArray(filter))
      throw badRequest("BAD_FILTER", "custom must be a JSON object");
    for (const [key, value] of Object.entries(filter)) {
      const def = fields.byKey.get(key);
      if (!def || def.isCore || def.archived || !isFieldVisible(ctx, key))
        throw badRequest("UNKNOWN_FIELD", "Unknown filter");
      if (!["select", "multi_select", "boolean", "user"].includes(def.type))
        throw badRequest("BAD_FILTER", `${key} can't be filtered yet`);
      const probe = def.type === "multi_select" ? { [key]: [value] } : { [key]: value };
      where.push(sql`${L.custom} @> ${JSON.stringify(probe)}::jsonb`);
    }
  }

  return where;
}

export async function listLeads(req: FastifyRequest, q: ListQuery) {
  const fields = await loadFieldRegistry(req);
  const ctx = { actor: req.actor!, fields };
  const where = [...leadFilters(req, q, fields), cursorWhere(q.sort, q.cursor)];
  const rows = await req.db
    .select()
    .from(L)
    .where(and(...where))
    .orderBy(...orderBy(q.sort))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const tags = page.length
    ? await req.db
        .select()
        .from(schema.leadTags)
        .where(
          inArray(
            schema.leadTags.leadId,
            page.map((r) => r.id),
          ),
        )
    : [];
  return {
    items: page.map((r) =>
      serializeLead(r, { ...ctx, tagIds: tags.filter((t) => t.leadId === r.id).map((t) => t.tagId) }),
    ),
    nextCursor: rows.length > q.limit ? encodeCursor(q.sort, page.at(-1)!) : null,
  };
}

/** Board counts per stage, for the same filters as the list and only the leads the caller may see (RLS). */
export async function countLeads(req: FastifyRequest, q: FilterQuery & { pipelineId: string }) {
  const fields = await loadFieldRegistry(req);
  const rows = await req.db
    .select({ stageId: L.stageId, n: sql<number>`count(*)::int` })
    .from(L)
    .where(and(...leadFilters(req, q, fields)))
    .groupBy(L.stageId);
  return {
    counts: Object.fromEntries(rows.map((r) => [r.stageId, r.n])),
    total: rows.reduce((sum, r) => sum + r.n, 0),
  };
}
