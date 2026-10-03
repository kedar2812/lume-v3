import { can } from "@lume/core/shared";
import { OverviewTab } from "@/components/settings/security/OverviewTab";
import { SecurityTabs } from "@/components/settings/security/SecurityTabs";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { Alert, SecurityActivity } from "@/lib/settings/security";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";
import { SECURITY_LEDE, SECURITY_TABS } from "./tabs";

export const metadata = { title: "Security · Settings · LUME" };

export default async function Page({ searchParams }: { searchParams: Promise<{ alert?: string }> }) {
  const session = await requirePermission("security.manage");
  const canAudit = can(session.actor, "audit.view");
  const [{ alert }, r, settings, activity] = await Promise.all([
    searchParams,
    apiGet<{ alerts: Alert[] }>("/api/v1/security/alerts?status=recent"),
    apiGet<{ timezone: string }>("/api/v1/settings"),
    canAudit ? apiGet<SecurityActivity>("/api/v1/security/activity") : null,
  ]);
  const tz = settings.data?.timezone ?? "UTC";
  return (
    <SettingsPage title="Security" description={SECURITY_LEDE}>
      <SecurityTabs tabs={SECURITY_TABS} />
      {r.status === 200 && r.data ? (
        <OverviewTab
          initial={r.data.alerts}
          timezone={tz}
          openId={alert && /^[0-9a-f-]{36}$/i.test(alert) ? alert : null}
          canOffboard={can(session.actor, "users.manage")}
          activity={activity?.status === 200 ? (activity.data ?? null) : null}
        />
      ) : (
        <p role="alert">LUME couldn&apos;t load the alerts just now. Reload the page to try again.</p>
      )}
    </SettingsPage>
  );
}
