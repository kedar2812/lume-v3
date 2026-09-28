import type { DuePresetDef, WorkingHours } from "@lume/core/shared";
import { DuePresetsEditor } from "@/components/settings/DuePresetsEditor";
import { FollowUpSettings, type FollowUpConfig } from "@/components/settings/FollowUpSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Follow-ups · Settings · LUME" };

export default async function Page() {
  await requirePermission("settings.manage");
  const [r, biz] = await Promise.all([
    apiGet<FollowUpConfig & { duePresets: DuePresetDef[] }>("/api/v1/settings/follow-ups"),
    apiGet<{ workingHours: WorkingHours; weekStart: number }>("/api/v1/settings"),
  ]);
  return (
    <SettingsPage
      title="Follow-ups"
      description="Nothing is left waiting: when a follow-up is overdue, the right people hear about it."
    >
      {r.status === 200 && r.data ? (
        <>
          <FollowUpSettings
            initial={r.data}
            {...(biz.data ? { workingHours: biz.data.workingHours, weekStart: biz.data.weekStart } : {})}
          />
          <DuePresetsEditor initial={r.data.duePresets} />
        </>
      ) : (
        // Never defaults in place of what's saved: Save would write them over it (3B final review).
        <p role="alert">LUME couldn&apos;t load these settings just now. Reload the page to try again.</p>
      )}
    </SettingsPage>
  );
}
