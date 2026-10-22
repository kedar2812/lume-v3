import { AiSettings } from "@/components/settings/ai/AiSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { AiProfileView, AiStatus } from "@/lib/ai/types";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "LUME AI · Settings · LUME" };

/** Settings → LUME AI (Autopilot spec 2026-10-19 §5): admins only. */
export default async function Page() {
  await requirePermission("settings.manage");
  const [profile, status] = await Promise.all([
    apiGet<AiProfileView>("/api/v1/ai/profile"),
    apiGet<AiStatus>("/api/v1/ai"),
  ]);
  return (
    <SettingsPage
      title="LUME AI"
      description="What LUME AI knows about your business, its voice and your standing choices."
    >
      {profile.status === 200 && profile.data ? (
        <AiSettings initial={profile.data} status={status.status === 200 ? status.data : null} />
      ) : (
        // Never defaults in place of what's saved: Save would write them over it (3B final review).
        <p role="alert">LUME couldn&apos;t load these settings just now. Reload the page to try again.</p>
      )}
    </SettingsPage>
  );
}
