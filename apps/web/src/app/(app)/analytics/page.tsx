import { Suspense } from "react";
import { can, scopeOf } from "@lume/core/shared";
import { Analytics } from "@/components/analytics/Analytics";
import { apiGet } from "@/server/api";
import { loadCatalog } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Analytics · LUME" };

export default async function Page() {
  const session = await requirePermission("analytics.view");
  const [catalog, settings, instagram] = await Promise.all([
    loadCatalog(),
    apiGet<{ timezone: string | null }>("/api/v1/settings"),
    apiGet<{ there: boolean }>("/api/v1/analytics/instagram/there"),
  ]);
  return (
    <Suspense>
      <Analytics
        catalog={catalog}
        showTeam={scopeOf(session.actor, "analytics.view") !== "own"}
        canExport={can(session.actor, "leads.export")}
        reach={scopeOf(session.actor, "analytics.view") ?? "own"}
        meId={session.user.id}
        canManageSources={can(session.actor, "integrations.manage")}
        seesMoney={can(session.actor, "analytics.revenue")}
        canEditSpend={can(session.actor, "settings.manage")}
        instagram={instagram.data?.there === true}
        timezone={settings.data?.timezone ?? session.user.timezone ?? "UTC"}
      />
    </Suspense>
  );
}
