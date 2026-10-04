import { and, asc, desc, eq, gt, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { leadScope, seesFullContacts } from "@lume/core";
import { schema } from "@lume/db";
import { HttpError, badRequest } from "../../http/errors";
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
  /** Leads that came from one source (an import's file). */
  source?: string;
  /** Leads that arrived after this instant (2B spec §8.3: "N new since yesterday · Show only these"). */
  arrivedAfter?: string;
  phoneStatus?: "valid" | "needs_country" | "invalid" | "missing";
  q?: string;
  createdFrom?: string;
  createdTo?: string;
  custom?: string; // JSON object: { fieldKey: value }
  /** 4B: an open lead messaged at least this many days ago, and not answered since. */
  noReplyDays?: number;
  /** 4B: lost at least this many days ago. */
  lostDaysAgo?: number;
  /** 4B: lost for this reason. */
  lostReasonId?: string;
  /** 4B: has an open follow-up whose time has passed. */
  followUpOverdue?: boolean;
  /**
   * 4B: added within today and the days before it (1 = today), in the business's timezone: by the enquiry
   * date when the lead has one (a sheet's), else by when it reached LUME, as the drawer's "Enquiry" line.
   */
  createdDays?: number;
  /** Exactly these leads (an analytics drill-down, 8A); never taken from a request's query string. */
  ids?: string[];
};

const L = schema.leads;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Spec §8.3: a lead "arrived" after `since` unless the viewer made it themselves — a sheet's leads always
 * arrive, even for the admin the sheet runs as. Row-level security still decides which leads are seen.
 */
export const arrivalsWhere = (since: Date, me: string) =>
  sql`(${L.createdAt} > ${since} AND (${L.createdBy} IS DISTINCT FROM ${me} OR EXISTS (SELECT 1 FROM lead_sources s WHERE s.id = ${L.sourceId} AND s.type IN ('google_sheet', 'webhook'))))`;

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

export const orderBy = (sort: ListQuery["sort"]) =>
  sort === "newest"
    ? [desc(L.id)]
    : sort === "oldest"
      ? [asc(L.id)]
      : sort === "updated"
        ? [desc(L.updatedAt), desc(L.id)]
        : [sql`lower(${L.name}) asc`, asc(L.id)];

export type FilterQuery = Omit<ListQuery, "cursor" | "limit" | "sort">;

/**
 * The person's own lead scope as an ordinary condition (7A). Row-level security already enforces it, but hidden
 * in a policy the planner can't use an index for it; spelled out here, "my leads" reads the owner index. It mirrors
 * RLS exactly and is never wider: team adds the team (the person included, once); without a leads.view grant RLS
 * still shows their own leads, so that's own too; 'all' adds nothing. Unassigned leads are 'all' only, as in RLS.
 */
export function scopeCondition(req: FastifyRequest): SQL | undefined {
  const actor = req.actor!;
  const scope = leadScope(actor);
  if (scope === "all") return undefined;
  if (scope === "team") return inArray(L.ownerId, [...new Set([actor.userId, ...actor.teamMemberIds])]);
  return eq(L.ownerId, actor.userId);
}

const DEFAULT_SEARCH_CAP = 10_000;
let searchCap = DEFAULT_SEARCH_CAP;
/** Tests only: a smaller cap on search candidates, or null for the default. */
export function setSearchCapForTests(n: number | null): void {
  searchCap = n ?? DEFAULT_SEARCH_CAP;
}

/** What a search asks lume_lead_search for: each pattern escaped; null is a branch not asked for. */
type SearchAsk = {
  name: string | null;
  prefix: string | null;
  email: string | null;
  instagram: string | null;
  digits: string | null;
};

/**
 * What a term searches (7A). Null when there's nothing to search: blank or one character (characters, not UTF-16
 * units: an emoji is one). Two characters are too short to look inside names (a trigram needs three), so they
 * match names that start with them. Three or more look inside the name and, for someone who sees contacts in
 * full, the visible contact fields; masked roles search names only (report §12.2 #4), a hidden field never.
 */
function searchAsk(req: FastifyRequest, q: FilterQuery, fields: FieldRegistry): SearchAsk | null {
  const term = q.q?.trim() ?? "";
  const length = [...term].length;
  // One character, or symbols only (nothing a name, email or number could be looked up by): no search.
  if (length < 2 || !/[\p{L}\p{N}]/u.test(term)) return null;
  const none: SearchAsk = { name: null, prefix: null, email: null, instagram: null, digits: null };
  // Lower-cased in SQL, the same way as the names it's compared with.
  if (length === 2) return { ...none, prefix: `${likeEscape(term)}%` };
  const ctx = { actor: req.actor!, fields };
  const like = `%${likeEscape(term)}%`;
  const full = seesFullContacts(req.actor!);
  const digits = term.replace(/\D/g, "");
  return {
    ...none,
    name: like,
    email: full && isFieldVisible(ctx, "email") ? like : null,
    instagram: full && isFieldVisible(ctx, "instagram") ? like : null,
    digits: full && digits.length >= 4 && isFieldVisible(ctx, "phone") ? `%${digits}%` : null,
  };
}

/** A search, resolved: the matching leads (at most the cap) and whether there were more. */
export type SearchHits = { ids: string[]; capped: boolean };

/** For what must take every match: a search past the cap is refused in words, never acted on in part. */
export function refuseCapped(hits: SearchHits | null): SearchHits | null {
  if (hits?.capped)
    throw new HttpError(
      422,
      "SEARCH_TOO_BROAD",
      `That search matches more than ${searchCap.toLocaleString("en-US")} leads. Narrow it, then try again.`,
    );
  return hits;
}

/**
 * Run a search before the list, counts, export or view that use it (7A). Past the cap the hits are the newest
 * matches; a list says so (searchCapped), and anything that must take every match (an export, a send queue)
 * refuses rather than act on part of them. Under row-level security no LIKE index on
 * leads can be used (LIKE isn't leakproof), so search reads lead_search through lume_lead_search (0048), which
 * applies the leads policies' rule itself. Only ids come back; whatever uses them reads leads under RLS.
 */
export async function resolveSearch(
  req: FastifyRequest,
  q: FilterQuery,
  fields: FieldRegistry,
): Promise<SearchHits | null> {
  const ask = searchAsk(req, q, fields);
  if (!ask) return null;
  const { rows } = await req.db.execute<{ id: string }>(
    sql`SELECT lume_lead_search(${ask.name}, ${ask.prefix}, ${ask.email}, ${ask.instagram}, ${ask.digits}, ${searchCap + 1}) AS id`,
  );
  return { ids: rows.slice(0, searchCap).map((r) => r.id), capped: rows.length > searchCap };
}

/**
 * The WHERE for a set of filters. A search must be resolved first (resolveSearch) and its hits passed in: the list,
 * the counts and an export then filter on exactly the same leads.
 */
export function leadFilters(
  req: FastifyRequest,
  q: FilterQuery,
  fields: FieldRegistry,
  hits: SearchHits | null = null,
): (SQL | undefined)[] {
  const ctx = { actor: req.actor!, fields };
  const where: (SQL | undefined)[] = [isNull(L.deletedAt), scopeCondition(req)];

  if (q.pipelineId) where.push(eq(L.pipelineId, q.pipelineId));
  if (q.stageId) where.push(inArray(L.stageId, q.stageId.split(",")));
  if (q.ownerId === "me") where.push(eq(L.ownerId, req.actor!.userId));
  else if (q.ownerId === "none") where.push(isNull(L.ownerId));
  else if (q.ownerId) where.push(eq(L.ownerId, q.ownerId));
  if (q.tagId)
    // uuid equality is leakproof, so under row-level security this still reads lead_tags' tag index (7A review).
    where.push(sql`EXISTS (SELECT 1 FROM lead_tags t WHERE t.lead_id = ${L.id} AND t.tag_id = ${q.tagId})`);
  if (q.source) where.push(eq(L.sourceId, q.source));
  if (q.ids) where.push(q.ids.length ? sql`${L.id} = ANY(${`{${q.ids.join(",")}}`}::uuid[])` : sql`false`);
  if (q.arrivedAfter) where.push(arrivalsWhere(new Date(q.arrivedAfter), req.actor!.userId));
  if (q.phoneStatus) {
    if (!isFieldVisible(ctx, "phone")) throw badRequest("UNKNOWN_FIELD", "Unknown filter");
    where.push(eq(L.phoneStatus, q.phoneStatus));
  }
  if (q.createdFrom) where.push(sql`${L.leadCreatedAt} >= ${q.createdFrom}::date`);
  if (q.createdTo) where.push(sql`${L.leadCreatedAt} <= ${q.createdTo}::date`);

  // 4B: what's gone quiet. Stage kinds, not names: no client's stages are ever assumed.
  const kind = (k: "open" | "lost") =>
    sql`EXISTS (SELECT 1 FROM stages s WHERE s.id = ${L.stageId} AND s.kind = ${k})`;
  if (q.noReplyDays)
    where.push(
      sql`${L.lastMessageAt} <= now() - make_interval(days => ${q.noReplyDays}) AND (${L.lastReplyAt} IS NULL OR ${L.lastReplyAt} < ${L.lastMessageAt})`,
      kind("open"),
    );
  if (q.lostDaysAgo !== undefined)
    where.push(kind("lost"), sql`${L.lostAt} <= now() - make_interval(days => ${q.lostDaysAgo})`);
  if (q.lostReasonId) where.push(kind("lost"), eq(L.lostReasonId, q.lostReasonId));
  // Row-level security on tasks follows the lead, so this never reveals anyone else's.
  if (q.followUpOverdue)
    where.push(
      sql`EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = ${L.id} AND t.status = 'open' AND t.due_at < now())`,
    );
  if (q.createdDays) {
    // Midnight where the business is, whatever zone the server runs in (Review Focus 5).
    const tz = sql`(SELECT timezone FROM settings LIMIT 1)`;
    // Between N-1 days ago and today: an enquiry dated ahead isn't "new today". The enquiry date when there is one,
    // else the day the lead arrived; written as two ranges so each reads its index (7A: the sidebar counts this).
    const today = sql`(now() AT TIME ZONE ${tz})::date`;
    const first = sql`(${today} - ${q.createdDays - 1}::int)`;
    where.push(
      sql`(${L.leadCreatedAt} BETWEEN ${first} AND ${today}
           OR (${L.leadCreatedAt} IS NULL AND ${L.createdAt} >= (${first}::timestamp AT TIME ZONE ${tz})
               AND ${L.createdAt} < ((${today} + 1)::timestamp AT TIME ZONE ${tz})))`,
    );
  }

  // A search, resolved by the caller (resolveSearch): exactly its leads. A term the caller didn't resolve is refused
  // loudly in development rather than silently ignored.
  if (hits)
    where.push(hits.ids.length ? sql`${L.id} = ANY(${`{${hits.ids.join(",")}}`}::uuid[])` : sql`false`);
  else if (searchAsk(req, q, fields))
    throw new Error("leadFilters: resolve the search first (resolveSearch)");

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
  const hits = await resolveSearch(req, q, fields);
  const where = [...leadFilters(req, q, fields, hits), cursorWhere(q.sort, q.cursor)];
  const rows = await req.db
    .select()
    .from(L)
    .where(and(...where))
    .orderBy(...orderBy(q.sort))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const tagsOf = await tagsFor(
    req,
    page.map((r) => r.id),
  );
  return {
    items: page.map((r) => serializeLead(r, { ...ctx, tagIds: tagsOf.get(r.id) ?? [] })),
    searchCapped: hits?.capped ?? false,
    nextCursor: rows.length > q.limit ? encodeCursor(q.sort, page.at(-1)!) : null,
  };
}

/** Board counts per stage, for the same filters as the list and only the leads the caller may see (RLS). */
/** Each lead's tags, in one query, grouped once (never searched per lead). */
export async function tagsFor(req: FastifyRequest, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  // One array parameter, not one per lead: an export asks for up to 25,000 (7A, at 1,000,000 leads).
  const rows = await req.db
    .select()
    .from(schema.leadTags)
    .where(sql`${schema.leadTags.leadId} = ANY(${`{${ids.join(",")}}`}::uuid[])`);
  for (const t of rows) out.set(t.leadId, [...(out.get(t.leadId) ?? []), t.tagId]);
  return out;
}

/** Fold the counts' deltas into lead_counts (0048): the follow-up clock's minute tick. */
export async function rollupLeadCounts(pool: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  await pool.query("SELECT lume_lead_counts_rollup()");
}

/** The filters lead_counts (0048) can answer: pipeline, owner and stage. Any other counts live. */
const COUNTED = new Set(["pipelineId", "ownerId", "stageId", "sort"]);

/**
 * The stage strip from lead_counts_now (7A, 0048: kept counts plus deltas not yet rolled up): a handful of rows per
 * person instead of every lead. Row-level security shows each person the counts their lead scope allows; the owner
 * condition mirrors the list's.
 */
async function countFromTable(req: FastifyRequest, q: FilterQuery & { pipelineId: string }) {
  const where: SQL[] = [sql`pipeline_id = ${q.pipelineId}`];
  const actor = req.actor!;
  const scope = leadScope(actor);
  if (scope === "team")
    where.push(
      sql`owner_id = ANY(${`{${[...new Set([actor.userId, ...actor.teamMemberIds])].join(",")}}`}::uuid[])`,
    );
  else if (scope !== "all") where.push(sql`owner_id = ${actor.userId}`);
  if (q.ownerId === "me") where.push(sql`owner_id = ${actor.userId}`);
  else if (q.ownerId === "none") where.push(sql`owner_id IS NULL`);
  else if (q.ownerId) where.push(sql`owner_id = ${q.ownerId}`);
  if (q.stageId) where.push(sql`stage_id = ANY(${`{${q.stageId}}`}::uuid[])`);
  const { rows } = await req.db.execute<{ stage_id: string; n: number; value: string }>(sql`
    SELECT stage_id, sum(n)::int AS n, sum(value)::text AS value FROM lead_counts_now
     WHERE ${sql.join(where, sql` AND `)} GROUP BY stage_id HAVING sum(n) <> 0`);
  return {
    counts: Object.fromEntries(rows.map((r) => [r.stage_id, r.n])),
    values: Object.fromEntries(rows.map((r) => [r.stage_id, Number(r.value)])),
    total: rows.reduce((sum, r) => sum + r.n, 0),
    searchCapped: false,
  };
}

/** Whether lead_counts can answer these filters: a pipeline, and at most an owner and stages (a sort changes nothing). */
export function countable(q: FilterQuery): boolean {
  return !!q.pipelineId && Object.entries(q).every(([k, v]) => v === undefined || v === "" || COUNTED.has(k));
}

export async function countLeads(req: FastifyRequest, q: FilterQuery & { pipelineId: string }) {
  if (countable(q)) return countFromTable(req, q);
  const fields = await loadFieldRegistry(req);
  const hits = await resolveSearch(req, q, fields);
  const rows = await req.db
    .select({
      stageId: L.stageId,
      n: sql<number>`count(*)::int`,
      // Summed in SQL (numeric), so a column shows its total before every card is loaded.
      value: sql<string>`coalesce(sum(${L.value}), 0)::text`,
    })
    .from(L)
    .where(and(...leadFilters(req, q, fields, hits)))
    .groupBy(L.stageId);
  return {
    counts: Object.fromEntries(rows.map((r) => [r.stageId, r.n])),
    values: Object.fromEntries(rows.map((r) => [r.stageId, Number(r.value)])),
    total: rows.reduce((sum, r) => sum + r.n, 0),
    searchCapped: hits?.capped ?? false,
  };
}
