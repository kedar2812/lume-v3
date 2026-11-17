import { PeopleAdmin } from "@/components/settings/PeopleAdmin";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { Invite, RoleRef, UserRow } from "@/lib/settings/people";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "People · Settings · LUME" };

export default async function Page({ searchParams }: { searchParams: Promise<{ offboard?: string }> }) {
  const session = await requirePermission("users.manage");
  const { offboard } = await searchParams;
  const [users, invites, roles] = await Promise.all([
    apiGet<{ users: UserRow[] }>("/api/v1/users"),
    apiGet<{ invites: Invite[] }>("/api/v1/invites"),
    apiGet<{ roles: RoleRef[] }>("/api/v1/roles/assignable"),
  ]);
  // Never nobody in place of a team that couldn't be read: invites and roles go with it (bug hunt 2026-11-17).
  const read = users.status === 200 && invites.status === 200 && roles.status === 200;
  return (
    <SettingsPage title="People" description="Who uses LUME, what they can do, and who’s still to join.">
      {!read ? (
        <p role="alert">LUME couldn&apos;t load your team just now. Reload the page to try again.</p>
      ) : (
        <PeopleAdmin
          users={users.data?.users ?? []}
          invites={invites.data?.invites ?? []}
          roles={(roles.data?.roles ?? []).map(({ id, name }) => ({ id, name }))}
          session={session}
          offboard={offboard ?? null}
        />
      )}
    </SettingsPage>
  );
}
