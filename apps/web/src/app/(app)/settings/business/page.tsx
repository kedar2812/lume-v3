import { BusinessForm } from "@/components/settings/BusinessForm";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { BusinessSettings } from "@/lib/settings/client";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Business · Settings · LUME" };

export default async function Page() {
  await requirePermission("settings.manage");
  const r = await apiGet<BusinessSettings>("/api/v1/settings");
  return (
    <SettingsPage
      title="Business"
      description="Your name, clock and currency — what every screen in LUME is measured in."
    >
      <BusinessForm initial={r.status === 200 && r.data ? r.data : undefined} />
    </SettingsPage>
  );
}
