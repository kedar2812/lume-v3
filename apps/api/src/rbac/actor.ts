import type pg from "pg";
import {
  effectivePermissions,
  isPermissionKey,
  mergeFieldAccess,
  type Actor,
  type FieldAccess,
  type Grant,
  type Scope,
} from "@lume/core";
import type { LoginHours } from "@lume/db";

export type RoleRestriction = { loginHours: LoginHours | null; ipAllowlist: string[] | null };
export type ActorRecord = Actor & {
  restrictions: RoleRestriction[];
  /** Per-field access narrower than `edit` (report §7.1); empty for the owner. */
  fieldAccess: ReadonlyMap<string, FieldAccess>;
};

type GrantRow = {
  key: string | null;
  scope: Scope | null;
  role_id: string;
  login_hours: LoginHours | null;
  ip_allowlist: string[] | null;
};

/** Everything the permission check and RLS need for one user, in four indexed queries. Null = not an active user. */
export async function loadActor(pool: pg.Pool, userId: string): Promise<ActorRecord | null> {
  const [u, grants, team, fa] = await Promise.all([
    pool.query<{ is_owner: boolean; totp_enabled: boolean; status: string }>(
      "SELECT is_owner, totp_enabled, status FROM users WHERE id = $1",
      [userId],
    ),
    // The key comes from `permissions`, so a retired permission silently stops granting anything.
    pool.query<GrantRow>(
      `SELECT p.key, rp.scope, r.id AS role_id, r.login_hours, r.ip_allowlist::text[] AS ip_allowlist
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.key = rp.permission_key AND NOT p.retired
        WHERE ur.user_id = $1`,
      [userId],
    ),
    pool.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id FROM team_members lead
         JOIN teams t ON t.id = lead.team_id AND t.deleted_at IS NULL
         JOIN team_members m ON m.team_id = lead.team_id
        WHERE lead.user_id = $1 AND lead.is_lead`,
      [userId],
    ),
    pool.query<{ role_id: string; field_id: string; access: FieldAccess }>(
      `SELECT rfa.role_id, rfa.field_id, rfa.access
         FROM role_field_access rfa
         JOIN user_roles ur ON ur.role_id = rfa.role_id
         JOIN roles r ON r.id = rfa.role_id AND r.deleted_at IS NULL
        WHERE ur.user_id = $1`,
      [userId],
    ),
  ]);
  const user = u.rows[0];
  if (!user || user.status !== "active") return null;
  const restrictions = new Map<string, RoleRestriction>();
  const list: Grant[] = [];
  for (const g of grants.rows) {
    restrictions.set(g.role_id, { loginHours: g.login_hours, ipAllowlist: g.ip_allowlist });
    if (g.key && isPermissionKey(g.key)) list.push({ key: g.key, scope: g.scope });
  }
  return {
    userId,
    isOwner: user.is_owner,
    perms: effectivePermissions(list),
    teamMemberIds: team.rows.map((r) => r.user_id),
    twoFactorEnabled: user.totp_enabled,
    roleIds: [...restrictions.keys()],
    restrictions: [...restrictions.values()],
    fieldAccess: user.is_owner
      ? new Map()
      : mergeFieldAccess(
          [...restrictions.keys()],
          fa.rows.map((r) => ({ roleId: r.role_id, fieldId: r.field_id, access: r.access })),
        ),
  };
}
