import { Suspense } from "react";
import { Connected } from "@/components/integrations/Connected";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Connect with Google · Integrations · LUME" };

export default async function Page() {
  await requirePermission("integrations.manage");
  return (
    <SettingsPage title="Connect with Google" description="Pick up where Google left off.">
      <Suspense>
        <Connected />
      </Suspense>
    </SettingsPage>
  );
}
