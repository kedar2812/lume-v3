import { can } from "@lume/core/shared";
import { CalendarSettings } from "@/components/settings/CalendarSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import s from "@/components/settings/calendar-settings.module.css";
import type { CalendarConnection } from "@/lib/calendar/types";
import type { IntegrationsView } from "@/lib/sheets/types";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Calendar · Settings · LUME" };

export default async function Page() {
  const session = await requirePermission("calendar.connect");
  const admin = can(session.actor, "integrations.manage");
  const [connection, integrations] = await Promise.all([
    apiGet<CalendarConnection>("/api/v1/calendar/connection"),
    admin ? apiGet<IntegrationsView>("/api/v1/integrations") : Promise.resolve({ data: null }),
  ]);
  return (
    // CalendarSettings has its own way back: to the Calendar view the gear was pressed on.
    <SettingsPage
      up={null}
      title="Calendar"
      description="Your meetings with leads show in LUME, on their leads, and remind you to log how they went."
    >
      <div className={s.arrive}>
        <CalendarSettings
          initial={connection.data ?? { available: false, connected: false }}
          calendly={integrations.data ? { connected: integrations.data.calendly.connected } : null}
        />
      </div>
    </SettingsPage>
  );
}
