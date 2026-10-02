import { OverviewTab } from "@/components/settings/security/OverviewTab";
import { SecurityTabs } from "@/components/settings/security/SecurityTabs";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { Alert } from "@/lib/settings/security";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";
import { SECURITY_LEDE, SECURITY_TABS } from "./tabs";

export const metadata = { title: "Security · Settings · LUME" };

export default async function Page({ searchParams }: { searchParams: Promise<{ alert?: string }> }) {
  await requirePermission("security.manage");
  const [{ alert }, r, settings] = await Promise.all([
    searchParams,
    apiGet<{ alerts: Alert[] }>("/api/v1/security/alerts?status=recent"),
    apiGet<{ timezone: string }>("/api/v1/settings"),
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
        />
      ) : (
        <p role="alert">LUME couldn&apos;t load the alerts just now. Reload the page to try again.</p>
      )}
    </SettingsPage>
  );
}
