import { MessagingSettings, type MessagingConfig } from "@/components/settings/MessagingSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Messages · Settings · LUME" };

export default async function Page() {
  await requirePermission("settings.manage");
  const r = await apiGet<MessagingConfig>("/api/v1/settings/messaging");
  return (
    <SettingsPage
      title="Messages"
      description="How the send queue runs: how many leads at a time, and a daily limit."
    >
      {r.status === 200 && r.data ? (
        <MessagingSettings initial={r.data} />
      ) : (
        // Never defaults in place of what's saved: Save would write them over it.
        <p role="alert">LUME couldn&apos;t load these settings just now. Reload the page to try again.</p>
      )}
    </SettingsPage>
  );
}
