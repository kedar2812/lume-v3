import { PeopleAdmin } from "@/components/settings/PeopleAdmin";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { Invite, RoleRef, UserRow } from "@/lib/settings/people";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "People · Settings · LUME" };

export default async function Page() {
  const session = await requirePermission("users.manage");
  const [users, invites, roles] = await Promise.all([
    apiGet<{ users: UserRow[] }>("/api/v1/users"),
    apiGet<{ invites: Invite[] }>("/api/v1/invites"),
    apiGet<{ roles: RoleRef[] }>("/api/v1/roles/assignable"),
  ]);
  return (
    <SettingsPage title="People" description="Who uses LUME, what they can do, and who’s still to join.">
      <PeopleAdmin
        users={users.data?.users ?? []}
        invites={invites.data?.invites ?? []}
        roles={(roles.data?.roles ?? []).map(({ id, name }) => ({ id, name }))}
        session={session}
      />
    </SettingsPage>
  );
}
