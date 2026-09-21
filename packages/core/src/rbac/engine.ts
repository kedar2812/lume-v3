import { PERMISSIONS, SCOPE_RANK, permissionDef, type PermissionKey, type Scope } from "./catalog";

export type Grant = { key: PermissionKey; scope: Scope | null };

export type Actor = {
  userId: string;
  isOwner: boolean;
  perms: ReadonlyMap<PermissionKey, Scope | true>;
  /** Members of every team this user leads (drives `team` scope). */
  teamMemberIds: readonly string[];
  twoFactorEnabled: boolean;
  roleIds: readonly string[];
};

/** Union of all the user's roles; a scoped permission keeps its widest scope (report §5.1). */
export function effectivePermissions(grants: Grant[]): Map<PermissionKey, Scope | true> {
  const out = new Map<PermissionKey, Scope | true>();
  for (const g of grants) {
    if (!permissionDef(g.key).scoped) {
      out.set(g.key, true);
      continue;
    }
    const scope = g.scope ?? "own";
    const prev = out.get(g.key);
    if (prev === undefined || prev === true || SCOPE_RANK[scope] > SCOPE_RANK[prev]) out.set(g.key, scope);
  }
  return out;
}

export function scopeOf(actor: Actor, key: PermissionKey): Scope | null {
  if (actor.isOwner) return "all";
  const v = actor.perms.get(key);
  return v === undefined ? null : v === true ? "all" : v;
}

export function can(actor: Actor, key: PermissionKey, atLeast?: Scope): boolean {
  if (actor.isOwner) return true;
  const v = actor.perms.get(key);
  if (v === undefined) return false;
  if (!atLeast || v === true) return true;
  return SCOPE_RANK[v] >= SCOPE_RANK[atLeast];
}

/** The scope row-level security enforces for lead tables (report §7.4). */
export const leadScope = (actor: Actor): Scope | null => scopeOf(actor, "leads.view");

const TWO_FACTOR_KEYS: PermissionKey[] = ["users.manage", "roles.manage", "leads.export", "security.manage"];
/** Report §12.1: owner, people/role/security managers, anyone who can export, full contacts at `all`. */
export function requiresTwoFactor(actor: Actor): boolean {
  if (actor.isOwner) return true;
  if (TWO_FACTOR_KEYS.some((k) => actor.perms.has(k))) return true;
  return actor.perms.get("leads.contact.full") === "all";
}

export const ALL_GRANTS: Grant[] = PERMISSIONS.map((p) => ({ key: p.key, scope: p.scoped ? "all" : null }));
