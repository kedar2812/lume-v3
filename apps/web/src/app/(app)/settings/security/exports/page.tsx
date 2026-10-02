import { ExportsTab } from "@/components/settings/security/ExportsTab";
import { SecurityTabs } from "@/components/settings/security/SecurityTabs";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { ExportRow } from "@/lib/settings/security";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";
import { SECURITY_LEDE, SECURITY_TABS } from "../tabs";

export const metadata = { title: "Exports · Security · Settings · LUME" };

export default async function Page() {
  const session = await requirePermission("security.manage");
  const [r, settings] = await Promise.all([
    apiGet<{ exports: ExportRow[] }>("/api/v1/leads/exports"),
    apiGet<{ timezone: string }>("/api/v1/settings"),
  ]);
  return (
    <SettingsPage title="Security" description={SECURITY_LEDE}>
      <SecurityTabs tabs={SECURITY_TABS} />
      {r.status === 200 && r.data ? (
        <ExportsTab
          initial={r.data.exports}
          timezone={settings.data?.timezone ?? "UTC"}
          viewerId={session.user.id}
        />
      ) : (
        <p role="alert">LUME couldn&apos;t load the exports just now. Reload the page to try again.</p>
      )}
    </SettingsPage>
  );
}
