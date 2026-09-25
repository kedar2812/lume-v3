import { About } from "@/components/settings/About";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requireSession } from "@/server/session";

export const metadata = { title: "About · Settings · LUME" };

export default async function Page() {
  await requireSession();
  return (
    <SettingsPage title="About" description="Which LUME is running, and whether its backups restore.">
      <About />
    </SettingsPage>
  );
}
