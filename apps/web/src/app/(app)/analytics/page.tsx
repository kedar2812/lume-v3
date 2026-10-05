import { Suspense } from "react";
import { can, scopeOf } from "@lume/core/shared";
import { Analytics } from "@/components/analytics/Analytics";
import { apiGet } from "@/server/api";
import { loadCatalog } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Analytics · LUME" };

export default async function Page() {
  const session = await requirePermission("analytics.view");
  const [catalog, settings] = await Promise.all([
    loadCatalog(),
    apiGet<{ timezone: string | null }>("/api/v1/settings"),
  ]);
  return (
    <Suspense>
      <Analytics
        catalog={catalog}
        showTeam={scopeOf(session.actor, "analytics.view") !== "own"}
        canExport={can(session.actor, "leads.export")}
        seesMoney={can(session.actor, "analytics.revenue")}
        canEditSpend={can(session.actor, "settings.manage")}
        timezone={settings.data?.timezone ?? session.user.timezone ?? "UTC"}
      />
    </Suspense>
  );
}
