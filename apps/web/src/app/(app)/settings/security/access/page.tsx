import { AccessTab } from "@/components/settings/security/AccessTab";
import { SecurityTabs } from "@/components/settings/security/SecurityTabs";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { AccessView } from "@/lib/settings/security";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";
import { SECURITY_LEDE, SECURITY_TABS } from "../tabs";

export const metadata = { title: "Access limits · Security · Settings · LUME" };

export default async function Page() {
  await requirePermission("security.manage");
  const r = await apiGet<AccessView>("/api/v1/security/access");
  return (
    <SettingsPage title="Security" description={SECURITY_LEDE}>
      <SecurityTabs tabs={SECURITY_TABS} />
      {r.status === 200 && r.data ? (
        <AccessTab initial={r.data} />
      ) : (
        <p role="alert">LUME couldn&apos;t load the access limits just now. Reload the page to try again.</p>
      )}
    </SettingsPage>
  );
}
