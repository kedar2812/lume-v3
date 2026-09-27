import { Integrations } from "@/components/integrations/Integrations";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Integrations · Settings · LUME" };

export default async function Page() {
  await requirePermission("integrations.manage");
  return (
    <SettingsPage
      title="Integrations"
      description="Optional connections. Each one is off until you switch it on."
    >
      <Integrations />
    </SettingsPage>
  );
}
