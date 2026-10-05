import { can } from "@lume/core/shared";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { SpendEditor, type SpendSource } from "@/components/settings/SpendEditor";
import { apiGet } from "@/server/api";
import { loadCatalog } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Sources & spend · Settings · LUME" };

export default async function Page() {
  const session = await requirePermission("settings.manage");
  const [catalog, r] = await Promise.all([
    loadCatalog(),
    apiGet<{ sources: SpendSource[] }>("/api/v1/settings/sources"),
  ]);
  return (
    <SettingsPage
      title="Sources & spend"
      description="What each source costs you a month. Analytics then shows what a lead costs from it, and what everything spent brings back in revenue won."
    >
      {r.status === 200 && r.data ? (
        <SpendEditor
          initial={r.data.sources}
          currency={catalog.currency}
          seesMoney={can(session.actor, "analytics.revenue")}
        />
      ) : (
        <p role="alert">LUME couldn&apos;t load your sources just now. Reload the page to try again.</p>
      )}
    </SettingsPage>
  );
}
