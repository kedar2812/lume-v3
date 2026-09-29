import type { PhoneStatus } from "@lume/core/shared";
import type { Catalog, FieldDefView } from "./types";

export type Sort = "newest" | "oldest" | "updated" | "name";
export type ListFilters = {
  q?: string;
  stageIds: string[];
  owner?: "me" | "none" | string;
  tagId?: string;
  phoneStatus?: PhoneStatus;
  /** Leads from one source (an import's file): "From leads-march.csv". */
  source?: string;
  /** Leads that arrived after this instant (the "N new since yesterday" line); never in the address bar. */
  arrivedAfter?: string;
  from?: string;
  to?: string;
  sort: Sort;
  pipelineId?: string;
  /** Custom-field filters: an option id, a person id, or true/false, by field key. */
  custom?: Record<string, string | boolean>;
  /** 4B: what's gone quiet. Messaged N+ days ago and not answered since. */
  noReplyDays?: number;
  /** Lost at least N days ago, and (optionally) for this reason. */
  lostDaysAgo?: number;
  lostReasonId?: string;
  /** Has an open follow-up whose time has passed. */
  followUpOverdue?: boolean;
  /** Added within today and the N−1 days before it (1 = today), in the business's timezone. */
  createdDays?: number;
};

/** The choices More filters offers (4B); a link can only ever carry one of these. */
export const NO_REPLY_DAYS = [1, 3, 7, 14] as const;
export const LOST_DAYS = [7, 30, 90] as const;
export const CREATED_DAYS = [1, 7] as const;
const oneOf = (raw: string | null, allowed: readonly number[]) => {
  const n = Number(raw);
  return raw && allowed.includes(n) ? n : undefined;
};

// A source is named by the catalog when it can be; any well-formed id still filters (the chip says "an import").
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The custom-field types the API can filter on (a JSON containment probe). */
export const FILTERABLE_TYPES = new Set(["select", "multi_select", "boolean", "user"]);
export const filterableFields = (cat: Catalog): FieldDefView[] =>
  cat.fields.filter((f) => !f.isCore && !f.archived && f.access !== "hidden" && FILTERABLE_TYPES.has(f.type));

function customValue(def: FieldDefView, raw: string, cat: Catalog): string | boolean | undefined {
  switch (def.type) {
    case "boolean":
      return raw === "true" ? true : raw === "false" ? false : undefined;
    case "user":
      return cat.people.some((p) => p.id === raw) ? raw : undefined;
    default:
      return def.options.some((o) => o.id === raw && !o.archived) ? raw : undefined;
  }
}
export const EMPTY_FILTERS: ListFilters = { stageIds: [], sort: "newest" };
/** Cards per board column, per fetch (the first paint and each Show more). */
export const BOARD_PAGE = 25;

const SORTS: Sort[] = ["newest", "oldest", "updated", "name"];
const PHONE: PhoneStatus[] = ["valid", "needs_country", "invalid", "missing"];
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const realDate = (s: string | null): string | undefined =>
  s && DATE.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined;

/**
 * The address bar is input like any other: a pasted or stale link must never break the page. Anything
 * that doesn't name something in the catalog (a deleted stage or tag, a person who left) is dropped.
 * The paging cursor is never read from the URL.
 */
export function parseFilters(p: URLSearchParams, cat: Catalog): ListFilters {
  const stages = new Set(cat.pipelines.flatMap((pl) => pl.stages.map((s) => s.id)));
  const people = new Set(cat.people.map((x) => x.id));
  const q = p.get("q")?.trim().slice(0, 100);
  const owner = p.get("owner");
  const tag = p.get("tag");
  const phone = p.get("phone") as PhoneStatus | null;
  const source = p.get("source");
  const sort = p.get("sort") as Sort | null;
  const pipeline = p.get("pipeline");
  const from = realDate(p.get("from"));
  const noReply = oneOf(p.get("noreply"), NO_REPLY_DAYS);
  const lost = oneOf(p.get("lost"), LOST_DAYS);
  const reason = p.get("reason");
  const created = oneOf(p.get("new"), CREATED_DAYS);
  const to = realDate(p.get("to"));
  const fields = new Map(filterableFields(cat).map((f) => [f.key, f]));
  const custom: Record<string, string | boolean> = {};
  for (const [k, raw] of p) {
    if (!k.startsWith("cf.")) continue;
    const def = fields.get(k.slice(3));
    const v = def ? customValue(def, raw, cat) : undefined;
    if (def && v !== undefined) custom[def.key] = v;
  }
  return {
    ...(q ? { q } : {}),
    stageIds: [...new Set((p.get("stage") ?? "").split(",").filter((id) => stages.has(id)))].slice(0, 20),
    ...(owner === "me" || owner === "none" || (owner && people.has(owner)) ? { owner } : {}),
    ...(tag && cat.tags.some((t) => t.id === tag) ? { tagId: tag } : {}),
    ...(phone && PHONE.includes(phone) ? { phoneStatus: phone } : {}),
    ...(source && UUID.test(source) ? { source } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    sort: sort && SORTS.includes(sort) ? sort : "newest",
    ...(pipeline && cat.pipelines.some((x) => x.id === pipeline) ? { pipelineId: pipeline } : {}),
    ...(Object.keys(custom).length ? { custom } : {}),
    ...(noReply ? { noReplyDays: noReply } : {}),
    ...(lost ? { lostDaysAgo: lost } : {}),
    ...(reason && cat.lostReasons.some((r) => r.id === reason) ? { lostReasonId: reason } : {}),
    ...(p.get("overdue") === "1" ? { followUpOverdue: true } : {}),
    ...(created ? { createdDays: created } : {}),
  };
}

export function filtersToParams(f: ListFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.stageIds.length) p.set("stage", f.stageIds.join(","));
  if (f.owner) p.set("owner", f.owner);
  if (f.tagId) p.set("tag", f.tagId);
  if (f.phoneStatus) p.set("phone", f.phoneStatus);
  if (f.source) p.set("source", f.source);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.pipelineId) p.set("pipeline", f.pipelineId);
  for (const [k, v] of Object.entries(f.custom ?? {})) p.set(`cf.${k}`, String(v));
  if (f.noReplyDays) p.set("noreply", String(f.noReplyDays));
  if (f.lostDaysAgo) p.set("lost", String(f.lostDaysAgo));
  if (f.lostReasonId) p.set("reason", f.lostReasonId);
  if (f.followUpOverdue) p.set("overdue", "1");
  if (f.createdDays) p.set("new", String(f.createdDays));
  return p;
}

/** The API's query string for these filters (the list adds cursor and limit itself). */
export function apiQuery(f: ListFilters): string {
  const p = new URLSearchParams();
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (f.stageIds.length) p.set("stageId", f.stageIds.join(","));
  if (f.owner) p.set("ownerId", f.owner);
  if (f.tagId) p.set("tagId", f.tagId);
  if (f.phoneStatus) p.set("phoneStatus", f.phoneStatus);
  if (f.source) p.set("source", f.source);
  if (f.from) p.set("createdFrom", f.from);
  if (f.to) p.set("createdTo", f.to);
  if (f.arrivedAfter) p.set("arrivedAfter", f.arrivedAfter);
  if (f.pipelineId) p.set("pipelineId", f.pipelineId);
  if (f.custom && Object.keys(f.custom).length) p.set("custom", JSON.stringify(f.custom));
  if (f.noReplyDays) p.set("noReplyDays", String(f.noReplyDays));
  if (f.lostDaysAgo) p.set("lostDaysAgo", String(f.lostDaysAgo));
  if (f.lostReasonId) p.set("lostReasonId", f.lostReasonId);
  if (f.followUpOverdue) p.set("followUpOverdue", "true");
  if (f.createdDays) p.set("createdDays", String(f.createdDays));
  p.set("sort", f.sort);
  return p.toString();
}

export const activeFilterCount = (f: ListFilters): number =>
  [
    f.q,
    f.stageIds.length > 0,
    f.owner,
    f.tagId,
    f.phoneStatus,
    f.source,
    f.from || f.to,
    f.arrivedAfter,
    f.noReplyDays,
    f.lostDaysAgo,
    f.lostReasonId,
    f.followUpOverdue,
    f.createdDays,
  ].filter(Boolean).length + Object.keys(f.custom ?? {}).length;

/** How many of More filters' own are set (4B, and the business's fields). */
export const moreFilterCount = (f: ListFilters): number =>
  [f.noReplyDays, f.lostDaysAgo, f.followUpOverdue, f.createdDays].filter(Boolean).length +
  Object.keys(f.custom ?? {}).length;
