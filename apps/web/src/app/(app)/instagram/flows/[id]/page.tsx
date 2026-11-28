import { notFound } from "next/navigation";
import { Builder } from "@/components/flows/builder/Builder";
import type { FlowView } from "@/lib/flows/client";
import { apiGet } from "@/server/api";
import { loadCatalog } from "@/server/leads";
import { businessName, requirePermission } from "@/server/session";

export const metadata = { title: "Flow · Instagram · LUME" };

/** The flow builder (plan 2026-11-23-flow-builder, Part B): whoever may manage Instagram flows. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("instagram.flows.manage");
  const { id } = await params;
  const [r, catalog, list, business, settings] = await Promise.all([
    apiGet<FlowView>(`/api/v1/instagram/flows/${encodeURIComponent(id)}`),
    loadCatalog(),
    apiGet<{ flows: { id: string; name: string; status: string }[] }>("/api/v1/instagram/flows"),
    businessName(),
    // Its time zone, for the Numbers' ranges (they end on the business's today).
    apiGet<{ timezone: string | null }>("/api/v1/settings"),
  ]);
  if (r.status === 404) notFound();
  // Go to another flow may name a flow that's live or paused.
  const flows = (list.data?.flows ?? []).filter((f) => f.status === "live" || f.status === "paused");
  if (r.status === 200 && r.data)
    return (
      <Builder
        initial={r.data}
        catalog={catalog}
        flows={flows}
        businessName={business ?? "Your business"}
        tz={settings.data?.timezone ?? "UTC"}
      />
    );
  return (
    <p role="alert" style={{ margin: 24 }}>
      {r.status === 409
        ? "Instagram is off. Switch it on in Settings › Integrations first."
        : "LUME couldn't open this flow just now. Reload the page to try again."}
    </p>
  );
}
