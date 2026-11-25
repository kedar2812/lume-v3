import { Suspense } from "react";
import { InstagramConnected } from "@/components/integrations/InstagramConnected";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Connect Instagram · Integrations · LUME" };

export default async function Page() {
  await requirePermission("integrations.manage");
  return (
    <SettingsPage
      up={{ href: "/settings/integrations", label: "Integrations" }}
      title="Connect Instagram"
      description="Pick up where Instagram left off."
    >
      <Suspense>
        <InstagramConnected />
      </Suspense>
    </SettingsPage>
  );
}
