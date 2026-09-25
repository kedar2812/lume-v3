import { SettingsPage } from "@/components/settings/SettingsPage";
import { TeamsAdmin } from "@/components/settings/TeamsAdmin";
import type { Team } from "@/lib/settings/teams";
import { apiGet } from "@/server/api";
import { loadCatalog } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Teams · Settings · LUME" };

export default async function Page() {
  await requirePermission("teams.manage");
  const [teams, catalog] = await Promise.all([apiGet<{ teams: Team[] }>("/api/v1/teams"), loadCatalog()]);
  return (
    <SettingsPage
      title="Teams"
      description="Who works together. A team’s lead can see and help with its leads when their role allows."
    >
      <TeamsAdmin teams={teams.data?.teams ?? []} people={catalog.people} />
    </SettingsPage>
  );
}
