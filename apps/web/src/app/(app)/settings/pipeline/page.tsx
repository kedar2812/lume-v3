import { can } from "@lume/core/shared";
import { PipelineEditor } from "@/components/settings/PipelineEditor";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { IntegrationsView } from "@/lib/sheets/types";
import { apiGet } from "@/server/api";
import { loadCatalog } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Pipeline · Settings · LUME" };

export default async function Page() {
  const session = await requirePermission("pipelines.manage");
  const [{ pipelines, fields, people }, integrations] = await Promise.all([
    loadCatalog(),
    // Calendly's booking sentence (5D) shows to someone who can also see whether Calendly is connected.
    can(session.actor, "integrations.manage")
      ? apiGet<IntegrationsView>("/api/v1/integrations")
      : Promise.resolve({ data: null }),
  ]);
  return (
    <SettingsPage
      title="Pipeline & stages"
      description="The steps a lead moves through, and what LUME does at each one. Changes save as you make them."
    >
      <PipelineEditor
        pipelines={pipelines}
        fields={fields}
        people={people}
        calendly={!!integrations.data?.calendly.connected}
      />
    </SettingsPage>
  );
}
