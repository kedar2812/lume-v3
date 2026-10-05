import { can } from "@lume/core/shared";
import { GoalsEditor } from "@/components/settings/GoalsEditor";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { dayIn } from "@/lib/analytics/range";
import { apiGet } from "@/server/api";
import { loadCatalog } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Goals · Settings · LUME" };

export default async function Page() {
  const session = await requirePermission("settings.manage");
  const [catalog, settings] = await Promise.all([
    loadCatalog(),
    apiGet<{ timezone: string | null }>("/api/v1/settings"),
  ]);
  const tz = settings.data?.timezone ?? session.user.timezone ?? "UTC";
  return (
    <SettingsPage
      title="Goals"
      description="What the business, each team and each person aim for. Analytics shows progress and the pace, and the Monday email carries it."
    >
      <GoalsEditor
        currency={catalog.currency}
        seesMoney={can(session.actor, "analytics.revenue")}
        people={catalog.people}
        today={dayIn(new Date(), tz)}
      />
    </SettingsPage>
  );
}
