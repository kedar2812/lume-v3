import { FollowUpSettings, type FollowUpConfig } from "@/components/settings/FollowUpSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Follow-ups · Settings · LUME" };

export default async function Page() {
  await requirePermission("settings.manage");
  const r = await apiGet<FollowUpConfig>("/api/v1/settings/follow-ups");
  return (
    <SettingsPage
      title="Follow-ups"
      description="Nothing is left waiting: when a follow-up is overdue, the right people hear about it."
    >
      <FollowUpSettings
        initial={r.status === 200 && r.data ? r.data : { escalation: { enabled: true, hours: 24 } }}
      />
    </SettingsPage>
  );
}
