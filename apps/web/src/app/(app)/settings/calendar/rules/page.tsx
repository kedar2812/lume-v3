import { can, type CalendarRules as Rules } from "@lume/core/shared";
import { CalendarRules } from "@/components/settings/CalendarRules";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { CalendarConnection } from "@/lib/calendar/types";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Calendar rules · Settings · LUME" };

export default async function Page() {
  const session = await requirePermission("settings.manage");
  const [rules, connection] = await Promise.all([
    apiGet<{ rules: Rules }>("/api/v1/settings/calendar"),
    can(session.actor, "calendar.connect")
      ? apiGet<CalendarConnection>("/api/v1/calendar/connection")
      : Promise.resolve({ data: null }),
  ]);
  const conn = connection.data;
  return (
    <SettingsPage
      up={{ href: "/settings/calendar", label: "Calendar settings" }}
      title="Calendar rules"
      description="Which calendar events are meetings with leads. Everything else never comes into LUME. These apply to everyone's calendar."
    >
      <CalendarRules
        initial={rules.data?.rules ?? { attendeeIsLead: true, titleWords: [], calendarIds: [] }}
        calendars={conn?.connected ? conn.calendars.map((c) => ({ id: c.id, name: c.name })) : []}
      />
    </SettingsPage>
  );
}
