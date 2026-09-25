import { MyAccount } from "@/components/settings/MyAccount";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { ReplayTour } from "@/components/tour/ReplayTour";
import { requireSession } from "@/server/session";

export const metadata = { title: "My account · Settings · LUME" };

export default async function Page() {
  const session = await requireSession();
  return (
    <SettingsPage
      title="My account"
      description="Your name and look, how you sign in, and where you’re signed in."
    >
      <MyAccount session={session} />
      <ReplayTour />
    </SettingsPage>
  );
}
