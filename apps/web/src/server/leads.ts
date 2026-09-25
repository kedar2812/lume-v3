import { seesFullContacts } from "@lume/core/shared";
import { apiQuery, parseFilters, type ListFilters } from "@/lib/leads/filters";
import type {
  Catalog,
  FieldDefView,
  LeadPage,
  LostReason,
  Person,
  Pipeline,
  Product,
  Tag,
} from "@/lib/leads/types";
import { apiGet } from "./api";
import type { Session } from "./session";

/**
 * The catalog, fetched in parallel on the server with the visitor's cookie. A list the caller can't read
 * (403) is simply empty; the screens then leave that control out.
 */
export async function loadCatalog(): Promise<Catalog> {
  const [pipelines, fields, people, tags, reasons, products, settings] = await Promise.all([
    apiGet<{ pipelines: Pipeline[] }>("/api/v1/pipelines"),
    apiGet<{ fields: FieldDefView[] }>("/api/v1/fields"),
    apiGet<{ people: Person[] }>("/api/v1/people"),
    apiGet<{ tags: Tag[] }>("/api/v1/tags"),
    apiGet<{ lostReasons: LostReason[] }>("/api/v1/lost-reasons"),
    apiGet<{ products: Product[] }>("/api/v1/products"),
    apiGet<{ currency: string; defaultCountry: string | null }>("/api/v1/settings"),
  ]);
  return {
    pipelines: pipelines.data?.pipelines ?? [],
    fields: fields.data?.fields ?? [],
    people: people.data?.people ?? [],
    tags: tags.data?.tags ?? [],
    lostReasons: reasons.data?.lostReasons ?? [],
    products: products.data?.products ?? [],
    currency: settings.data?.currency ?? "AED",
    country: settings.data?.defaultCountry ?? null,
  };
}

/** Everything the leads table needs for its first paint: the catalog, and page one for the URL's filters. */
export async function loadLeadsPage(
  session: Session,
  search: URLSearchParams,
): Promise<{ catalog: Catalog; filters: ListFilters; first: LeadPage | null; contactsVisible: boolean }> {
  const catalog = await loadCatalog();
  const filters = parseFilters(search, catalog);
  const first = await apiGet<LeadPage>(`/api/v1/leads?${apiQuery(filters)}&limit=50`);
  return { catalog, filters, first: first.data, contactsVisible: seesFullContacts(session.actor) };
}

/**
 * Everything the board needs for its first paint: the chosen (or default) pipeline, its counts under the
 * URL's filters, and the first cards of every stage, all fetched in parallel. The board shows every stage,
 * so a stage filter in the link is ignored.
 */
export async function loadBoard(
  search: URLSearchParams,
  pageSize: number,
): Promise<{
  catalog: Catalog;
  pipeline: Pipeline | null;
  filters: ListFilters;
  columns: Record<string, LeadPage>;
  counts: Record<string, number>;
}> {
  const catalog = await loadCatalog();
  const parsed = parseFilters(search, catalog);
  const pipeline =
    catalog.pipelines.find((p) => p.id === parsed.pipelineId) ??
    catalog.pipelines.find((p) => p.isDefault) ??
    catalog.pipelines[0] ??
    null;
  const filters: ListFilters = { ...parsed, stageIds: [], pipelineId: undefined };
  if (!pipeline) return { catalog, pipeline, filters, columns: {}, counts: {} };
  const scoped = { ...filters, pipelineId: pipeline.id };
  const countQuery = new URLSearchParams(apiQuery(scoped));
  countQuery.delete("sort");
  const [counts, ...pages] = await Promise.all([
    apiGet<{ counts: Record<string, number> }>(`/api/v1/leads/counts?${countQuery}`),
    ...pipeline.stages.map((st) =>
      apiGet<LeadPage>(`/api/v1/leads?${apiQuery({ ...scoped, stageIds: [st.id] })}&limit=${pageSize}`),
    ),
  ]);
  return {
    catalog,
    pipeline,
    filters,
    columns: Object.fromEntries(
      pipeline.stages.map((st, i) => [st.id, pages[i]?.data ?? { items: [], nextCursor: null }]),
    ),
    counts: counts.data?.counts ?? {},
  };
}
