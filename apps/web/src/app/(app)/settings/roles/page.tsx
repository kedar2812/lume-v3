import { RolesAdmin } from "@/components/settings/RolesAdmin";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { PermissionDef, Role } from "@/lib/settings/roles";
import { apiGet } from "@/server/api";
import { loadCatalog } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Roles & access · Settings · LUME" };

export default async function Page() {
  await requirePermission("roles.manage");
  const [roles, permissions, catalog] = await Promise.all([
    apiGet<{ roles: Role[] }>("/api/v1/roles"),
    apiGet<{ permissions: PermissionDef[] }>("/api/v1/permissions"),
    loadCatalog(),
  ]);
  return (
    <SettingsPage
      title="Roles & access"
      description="What each role can do, how far it reaches (own, team, all), and which fields it sees."
    >
      <RolesAdmin
        roles={roles.data?.roles ?? []}
        catalog={permissions.data?.permissions ?? []}
        fields={catalog.fields}
      />
    </SettingsPage>
  );
}
