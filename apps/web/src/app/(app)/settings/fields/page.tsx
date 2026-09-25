import { FieldsEditor } from "@/components/settings/FieldsEditor";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { loadCatalog } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Fields · Settings · LUME" };

export default async function Page() {
  await requirePermission("fields.manage");
  const catalog = await loadCatalog();
  return (
    <SettingsPage
      title="Fields"
      description="What you keep about each lead. The preview shows the lead form as your team will see it."
    >
      <FieldsEditor catalog={catalog} />
    </SettingsPage>
  );
}
