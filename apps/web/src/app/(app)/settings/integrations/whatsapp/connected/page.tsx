import { Suspense } from "react";
import { WhatsAppConnected } from "@/components/integrations/WhatsAppConnected";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Connect WhatsApp · Integrations · LUME" };

export default async function Page() {
  await requirePermission("integrations.manage");
  return (
    <SettingsPage
      up={{ href: "/settings/integrations", label: "Integrations" }}
      title="Connect WhatsApp"
      description="Pick up where Facebook left off."
    >
      <Suspense>
        <WhatsAppConnected />
      </Suspense>
    </SettingsPage>
  );
}
