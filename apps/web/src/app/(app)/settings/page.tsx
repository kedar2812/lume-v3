import { SettingsHome } from "@/components/settings/SettingsHome";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { ReplayTour } from "@/components/tour/ReplayTour";
import { requireSession } from "@/server/session";

export const metadata = { title: "Settings · LUME" };

export default async function Page() {
  const session = await requireSession();
  return (
    <SettingsPage title="Settings" description="Shape LUME around how your business works.">
      <SettingsHome session={session} />
      <ReplayTour />
    </SettingsPage>
  );
}
