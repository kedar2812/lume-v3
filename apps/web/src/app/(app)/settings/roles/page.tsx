import { can } from "@lume/core/shared";
import { RolesAdmin } from "@/components/settings/RolesAdmin";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { UserRow } from "@/lib/settings/people";
import type { PermissionDef, Role } from "@/lib/settings/roles";
import { apiGet } from "@/server/api";
import { loadCatalog } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Roles & access · Settings · LUME" };

export default async function Page() {
  const session = await requirePermission("roles.manage");
  // Deleting a role is the top of the hierarchy (owner 2026-11-02): the owner, or someone who manages roles and people;
  // they see who holds each role, to choose what happens to them.
  const canDelete = session.user.isOwner || can(session.actor, "users.manage");
  const [roles, permissions, catalog, users] = await Promise.all([
    apiGet<{ roles: Role[] }>("/api/v1/roles"),
    apiGet<{ permissions: PermissionDef[] }>("/api/v1/permissions"),
    loadCatalog(),
    canDelete ? apiGet<{ users: UserRow[] }>("/api/v1/users") : Promise.resolve(null),
  ]);
  const people = (users?.data?.users ?? [])
    .filter((u) => u.status === "active" || u.status === "suspended")
    .map((u) => ({ id: u.id, name: u.name, isOwner: u.isOwner, roleIds: u.roles.map((r) => r.id) }));
  return (
    <SettingsPage
      title="Roles & access"
      description="What each role can do, how far it reaches (own, team, all), and which fields it sees."
    >
      <RolesAdmin
        roles={roles.data?.roles ?? []}
        catalog={permissions.data?.permissions ?? []}
        fields={catalog.fields}
        people={people}
        me={session.user.id}
        twoStep={session.twoFactor.enabled}
        canDelete={canDelete}
      />
    </SettingsPage>
  );
}
