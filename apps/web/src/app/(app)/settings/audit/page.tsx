import { AuditLog } from "@/components/settings/AuditLog";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { Person } from "@/lib/leads/types";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Audit log · Settings · LUME" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; action?: string; day?: string }>;
}) {
  await requirePermission("audit.view");
  const { actor, action, day } = await searchParams;
  const people = await apiGet<{ people: Person[] }>("/api/v1/people");
  return (
    <SettingsPage title="Audit log" description="Who did what in LUME, and when.">
      <AuditLog
        people={people.data?.people ?? []}
        {...(actor && /^[0-9a-f-]{36}$/i.test(actor) ? { initialActor: actor } : {})}
        {...(action && /^[a-z_.]{2,80}$/.test(action) ? { initialAction: action } : {})}
        {...(day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? { initialDay: day } : {})}
      />
    </SettingsPage>
  );
}
