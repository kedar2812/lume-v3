import type { WorkingHours as Hours } from "@lume/core/shared";
import { BusinessForm } from "@/components/settings/BusinessForm";
import { WorkingHours } from "@/components/settings/WorkingHours";
import s from "@/components/settings/settings.module.css";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { BusinessSettings } from "@/lib/settings/client";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Business · Settings · LUME" };

export default async function Page() {
  await requirePermission("settings.manage");
  const r = await apiGet<BusinessSettings & { workingHours: Hours }>("/api/v1/settings");
  return (
    <SettingsPage
      title="Business"
      description="Your name, clock and currency — what every screen in LUME is measured in."
    >
      <div className={s.stack}>
        <BusinessForm initial={r.status === 200 && r.data ? r.data : undefined} />
        {r.status === 200 && r.data && (
          <WorkingHours
            initial={r.data.workingHours}
            weekStart={r.data.weekStart}
            timezone={r.data.timezone}
          />
        )}
      </div>
    </SettingsPage>
  );
}
