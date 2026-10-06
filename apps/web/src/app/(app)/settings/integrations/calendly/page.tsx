import { CalendlyCard } from "@/components/integrations/CalendlyCard";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { CalendlyView } from "@/lib/calendar/types";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Calendly · Integrations · LUME" };

/** Calendly on its own (linked from the Calendar, Settings → Calendar and the pipeline's booking sentence). */
export default async function Page() {
  await requirePermission("integrations.manage");
  const view = await apiGet<CalendlyView>("/api/v1/integrations/calendly");
  return (
    <SettingsPage
      up={{ href: "/settings/integrations", label: "Integrations" }}
      title="Calendly"
      description="Bookings become leads in their booking stage, on their own."
    >
      <CalendlyCard initial={view.data ?? { connected: false }} />
    </SettingsPage>
  );
}
