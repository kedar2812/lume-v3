import { StoragePage } from "@/components/settings/storage/StoragePage";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { Storage } from "@/lib/settings/storage";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Storage · Settings · LUME" };

/** Settings › Storage (plan 2026-11-23-storage-clean-up): admins. */
export default async function Page() {
  await requirePermission("settings.manage");
  const r = await apiGet<Storage>("/api/v1/storage");
  if (r.status === 200 && r.data) return <StoragePage initial={r.data} />;
  return (
    <SettingsPage
      title="Storage"
      description="What LUME keeps on this server, and the room it can give back."
    >
      <p role="alert">LUME couldn&apos;t measure the disk just now. Reload the page to try again.</p>
    </SettingsPage>
  );
}
