import { can } from "@lume/core/shared";
import { CalendarGear } from "@/components/calendar/CalendarGear";
import { CalendarScreen } from "@/components/calendar/CalendarScreen";
import { readCalendarUrl, showsEveryone } from "@/lib/calendar/agenda";
import type { CalendarConnection } from "@/lib/calendar/types";
import type { Person, Pipeline } from "@/lib/leads/types";
import type { IntegrationsView } from "@/lib/sheets/types";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Calendar · LUME" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("calendar.view");
  const raw = await searchParams;
  const params = new URLSearchParams(
    Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])),
  );
  const [settings, people, pipelines, connection, integrations] = await Promise.all([
    apiGet<{ timezone: string; weekStart: number }>("/api/v1/settings"),
    apiGet<{ people: Person[] }>("/api/v1/people"),
    apiGet<{ pipelines: Pipeline[] }>("/api/v1/pipelines"),
    can(session.actor, "calendar.connect")
      ? apiGet<CalendarConnection>("/api/v1/calendar/connection")
      : Promise.resolve({ data: null }),
    can(session.actor, "integrations.manage")
      ? apiGet<IntegrationsView>("/api/v1/integrations")
      : Promise.resolve({ data: null }),
  ]);
  const conn = connection.data;
  const admin = can(session.actor, "integrations.manage");
  // Connecting (Task 5): offered only to someone who may, while the module is on and set up.
  const connect: { state: "connect" | "off" | "unavailable" | "noPermission"; admin: boolean } | null = !can(
    session.actor,
    "calendar.connect",
  )
    ? { state: "noPermission", admin }
    : conn?.connected
      ? null
      : conn?.available
        ? { state: "connect", admin }
        : integrations.data && !integrations.data.googleCalendar.available
          ? { state: "unavailable", admin }
          : { state: "off", admin };
  const stages = (pipelines.data?.pipelines ?? []).flatMap((p) =>
    p.stages.map((st) => ({ id: st.id, name: st.name, color: st.color })),
  );
  return (
    <section data-stagger>
      <CalendarScreen
        me={session.user.id}
        tz={settings.data?.timezone ?? "UTC"}
        weekStart={settings.data?.weekStart === 0 ? "sunday" : "monday"}
        everyone={showsEveryone(session.actor)}
        people={(people.data?.people ?? []).map((p) => ({ id: p.id, name: p.name }))}
        stages={stages}
        initial={readCalendarUrl(params)}
        connect={connect}
        gear={can(session.actor, "calendar.connect") ? <CalendarGear /> : undefined}
        refreshable={conn?.connected ? { needsReconnect: conn.status === "needs_reconnect" } : null}
        sources={{
          google:
            conn && conn.connected
              ? { syncedAt: conn.lastSyncedAt, healthy: conn.status === "active" }
              : null,
          calendly: !!integrations.data?.calendly.connected,
        }}
      />
    </section>
  );
}
