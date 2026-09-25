import { LeadsScreen } from "@/components/leads/LeadsScreen";
import { loadLeadsPage } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Leads · LUME" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("leads.view");
  const raw = await searchParams;
  const params = new URLSearchParams(
    Object.entries(raw).flatMap(([k, v]) =>
      v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]],
    ),
  );
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
    />
  );
}
