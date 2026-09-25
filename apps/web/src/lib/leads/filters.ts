import type { PhoneStatus } from "@lume/core/shared";
import type { Catalog, FieldDefView } from "./types";

export type Sort = "newest" | "oldest" | "updated" | "name";
export type ListFilters = {
  q?: string;
  stageIds: string[];
  owner?: "me" | "none" | string;
  tagId?: string;
  phoneStatus?: PhoneStatus;
  from?: string;
  to?: string;
  sort: Sort;
  pipelineId?: string;
  /** Custom-field filters: an option id, a person id, or true/false, by field key. */
  custom?: Record<string, string | boolean>;
};

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
  const sort = p.get("sort") as Sort | null;
  const pipeline = p.get("pipeline");
  const from = realDate(p.get("from"));
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
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    sort: sort && SORTS.includes(sort) ? sort : "newest",
    ...(pipeline && cat.pipelines.some((x) => x.id === pipeline) ? { pipelineId: pipeline } : {}),
    ...(Object.keys(custom).length ? { custom } : {}),
  };
}

export function filtersToParams(f: ListFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.stageIds.length) p.set("stage", f.stageIds.join(","));
  if (f.owner) p.set("owner", f.owner);
  if (f.tagId) p.set("tag", f.tagId);
  if (f.phoneStatus) p.set("phone", f.phoneStatus);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.pipelineId) p.set("pipeline", f.pipelineId);
  for (const [k, v] of Object.entries(f.custom ?? {})) p.set(`cf.${k}`, String(v));
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
  if (f.from) p.set("createdFrom", f.from);
  if (f.to) p.set("createdTo", f.to);
  if (f.pipelineId) p.set("pipelineId", f.pipelineId);
  if (f.custom && Object.keys(f.custom).length) p.set("custom", JSON.stringify(f.custom));
  p.set("sort", f.sort);
  return p.toString();
}

export const activeFilterCount = (f: ListFilters): number =>
  [f.q, f.stageIds.length > 0, f.owner, f.tagId, f.phoneStatus, f.from || f.to].filter(Boolean).length +
  Object.keys(f.custom ?? {}).length;
