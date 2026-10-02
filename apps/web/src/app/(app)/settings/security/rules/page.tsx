import { RulesTab } from "@/components/settings/security/RulesTab";
import { SecurityTabs } from "@/components/settings/security/SecurityTabs";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { SecuritySettings } from "@/lib/settings/security";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";
import { SECURITY_LEDE, SECURITY_TABS } from "../tabs";

export const metadata = { title: "Rules · Security · Settings · LUME" };

export default async function Page() {
  const session = await requirePermission("security.manage");
  const r = await apiGet<SecuritySettings>("/api/v1/security/settings");
  return (
    <SettingsPage title="Security" description={SECURITY_LEDE}>
      <SecurityTabs tabs={SECURITY_TABS} />
      {r.status === 200 && r.data ? (
        <RulesTab
          initial={r.data}
          viewer={{ name: session.user.name, email: session.user.email, today: session.today }}
        />
      ) : (
        // Never defaults in place of what's saved: a change would write them over it.
        <p role="alert">LUME couldn&apos;t load these settings just now. Reload the page to try again.</p>
      )}
    </SettingsPage>
  );
}
