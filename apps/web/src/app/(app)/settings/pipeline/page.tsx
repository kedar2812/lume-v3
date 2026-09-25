import { PipelineEditor } from "@/components/settings/PipelineEditor";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { loadCatalog } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Pipeline · Settings · LUME" };

export default async function Page() {
  await requirePermission("pipelines.manage");
  const { pipelines, fields } = await loadCatalog();
  return (
    <SettingsPage
      title="Pipeline & stages"
      description="The steps a lead moves through. Changes save as you make them."
    >
      <PipelineEditor pipelines={pipelines} fields={fields} />
    </SettingsPage>
  );
}
