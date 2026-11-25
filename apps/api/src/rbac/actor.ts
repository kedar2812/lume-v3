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
import { demoMode } from "../demo/mode";

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

/**
 * What deciding "may they see this?" needs of many people at once, in three queries however many they are (a message
 * that names a whole team). Only active people are among them.
 */
export async function loadActors(
  db: pg.Pool | pg.PoolClient,
  ids: string[],
): Promise<Map<string, Pick<Actor, "userId" | "isOwner" | "perms" | "teamMemberIds">>> {
  const users = await db.query<{ id: string; is_owner: boolean }>(
    "SELECT id, is_owner FROM users WHERE id = ANY($1) AND status = 'active'",
    [ids],
  );
  const grants = await db.query<{ user_id: string; key: string; scope: Scope | null }>(
    `SELECT ur.user_id, p.key, rp.scope
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.key = rp.permission_key AND NOT p.retired
      WHERE ur.user_id = ANY($1)`,
    [ids],
  );
  const teams = await db.query<{ lead: string; user_id: string }>(
    `SELECT DISTINCT lead.user_id AS lead, m.user_id FROM team_members lead
       JOIN teams t ON t.id = lead.team_id AND t.deleted_at IS NULL
       JOIN team_members m ON m.team_id = lead.team_id
      WHERE lead.user_id = ANY($1) AND lead.is_lead`,
    [ids],
  );
  const of = new Map<string, Grant[]>();
  for (const g of grants.rows)
    if (isPermissionKey(g.key))
      of.set(g.user_id, [...(of.get(g.user_id) ?? []), { key: g.key, scope: g.scope }]);
  const leads = new Map<string, string[]>();
  for (const t of teams.rows) leads.set(t.lead, [...(leads.get(t.lead) ?? []), t.user_id]);
  return new Map(
    users.rows.map((u) => [
      u.id,
      {
        userId: u.id,
        isOwner: u.is_owner,
        perms: effectivePermissions(of.get(u.id) ?? []),
        teamMemberIds: leads.get(u.id) ?? [],
      },
    ]),
  );
}

/** Everything the permission check and RLS need for one user, in four indexed queries. Null = not an active user. */
export async function loadActor(pool: pg.Pool | pg.PoolClient, userId: string): Promise<ActorRecord | null> {
  // A pool runs the four at once; one connection (a job's own transaction) takes them in turn.
  const readUser = () =>
    pool.query<{ is_owner: boolean; totp_enabled: boolean; status: string }>(
      "SELECT is_owner, totp_enabled, status FROM users WHERE id = $1",
      [userId],
    );
  // The key comes from `permissions`, so a retired permission silently stops granting anything.
  const readGrants = () =>
    pool.query<GrantRow>(
      `SELECT p.key, rp.scope, r.id AS role_id, r.login_hours, r.ip_allowlist::text[] AS ip_allowlist
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.key = rp.permission_key AND NOT p.retired
        WHERE ur.user_id = $1`,
      [userId],
    );
  const readTeam = () =>
    pool.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id FROM team_members lead
         JOIN teams t ON t.id = lead.team_id AND t.deleted_at IS NULL
         JOIN team_members m ON m.team_id = lead.team_id
        WHERE lead.user_id = $1 AND lead.is_lead`,
      [userId],
    );
  const readFieldAccess = () =>
    pool.query<{ role_id: string; field_id: string; access: FieldAccess }>(
      `SELECT rfa.role_id, rfa.field_id, rfa.access
         FROM role_field_access rfa
         JOIN user_roles ur ON ur.role_id = rfa.role_id
         JOIN roles r ON r.id = rfa.role_id AND r.deleted_at IS NULL
        WHERE ur.user_id = $1`,
      [userId],
    );
  const [u, grants, team, fa] =
    "release" in pool
      ? ([await readUser(), await readGrants(), await readTeam(), await readFieldAccess()] as const)
      : await Promise.all([readUser(), readGrants(), readTeam(), readFieldAccess()]);
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
    ...(demoMode() ? { twoFactorWaived: true } : {}),
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
