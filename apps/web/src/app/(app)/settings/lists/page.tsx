import { redirect } from "next/navigation";
import { can } from "@lume/core/shared";
import { Lists } from "@/components/settings/Lists";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { loadCatalog } from "@/server/leads";
import { requireSession } from "@/server/session";

export const metadata = { title: "Lists · Settings · LUME" };

export default async function Page() {
  const { actor } = await requireSession();
  const manage = { reasons: can(actor, "pipelines.manage"), tagsAndPackages: can(actor, "settings.manage") };
  if (!manage.reasons && !manage.tagsAndPackages) redirect("/today");
  const catalog = await loadCatalog();
  return (
    <SettingsPage title="Lists" description="The short lists your team picks from while working leads.">
      <Lists catalog={catalog} manage={manage} />
    </SettingsPage>
  );
}
