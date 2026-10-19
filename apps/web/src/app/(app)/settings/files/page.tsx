import { FileLibrary } from "@/components/settings/FileLibrary";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Files · Settings · LUME" };

export default async function Page() {
  await requirePermission("templates.manage");
  return (
    <SettingsPage
      title="Files"
      description="Brochures, price lists and photos, kept once and sent from any lead."
    >
      <FileLibrary />
    </SettingsPage>
  );
}
