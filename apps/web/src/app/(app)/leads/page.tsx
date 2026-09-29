import { LeadsScreen } from "@/components/leads/LeadsScreen";
import { viewParams } from "@/lib/leads/filters";
import type { ViewView } from "@/lib/views/client";
import { apiGet } from "@/server/api";
import { loadLeadsPage } from "@/server/leads";
import { requirePermission } from "@/server/session";

const UUID = /^[0-9a-f-]{36}$/;

export const metadata = { title: "Leads · LUME" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("leads.view");
  const raw = await searchParams;
  let params = new URLSearchParams(
    Object.entries(raw).flatMap(([k, v]) =>
      v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]],
    ),
  );
  // A saved view (4B): opened from the sidebar it brings its own filters; reloaded after a change, the
  // address already holds the filters as they now stand, and those win.
  const viewId = params.get("view");
  let view: ViewView | null = null;
  if (viewId && UUID.test(viewId)) {
    const views = await apiGet<{ views: ViewView[] }>("/api/v1/views");
    view = views.data?.views.find((v) => v.id === viewId) ?? null;
    const ownFilters = [...params.keys()].some((k) => k !== "view" && k !== "lead");
    if (view && !ownFilters) {
      const lead = params.get("lead");
      params = viewParams(view.filters);
      if (lead) params.set("lead", lead);
    }
  }
  const { catalog, filters, first, contactsVisible } = await loadLeadsPage(session, params);
  const lead = params.get("lead");
  return (
    <LeadsScreen
      session={session}
      catalog={catalog}
      contactsVisible={contactsVisible}
      initialFilters={filters}
      first={first}
      initialLeadId={lead && /^[0-9a-f-]{36}$/.test(lead) ? lead : null}
      view={view}
    />
  );
}
