import { ImportsList } from "@/components/settings/ImportsList";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Imports · Settings · LUME" };

export default async function Page() {
  await requirePermission("leads.import");
  return (
    <SettingsPage title="Imports" description="Every import, its report, and drafts to finish.">
      <ImportsList />
    </SettingsPage>
  );
}
