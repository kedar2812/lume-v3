import { SettingsPage } from "@/components/settings/SettingsPage";
import { SystemHealth } from "@/components/settings/SystemHealth";
import type { Health } from "@/lib/settings/health";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "System health · Settings · LUME" };

export default async function Page() {
  await requirePermission("settings.manage");
  const r = await apiGet<Health>("/api/v1/system/health");
  return (
    <SettingsPage
      title="System health"
      description="Whether LUME is keeping its promises: every reminder on time, every email sent, every source synced."
    >
      {r.status === 200 && r.data ? (
        <SystemHealth initial={r.data} />
      ) : (
        <p role="alert">LUME couldn&apos;t check just now. Reload the page to try again.</p>
      )}
    </SettingsPage>
  );
}
