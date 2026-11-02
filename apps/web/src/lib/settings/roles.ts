"use client";
import type { LeadsChoice } from "@/lib/settings/people";
import { api } from "@/lib/api";

export type Scope = "own" | "team" | "all";
export type PermissionDef = {
  key: string;
  group: string;
  label: string;
  description: string;
  scoped: boolean;
};
export type Grant = { key: string; scope: Scope | null };
export type FieldAccessLevel = "hidden" | "view" | "edit";
/** What happens to the people who hold a role being deleted (owner 2026-11-02). */
export type RolePeople =
  | { to: "role"; roleId: string }
  | { to: "new"; name: string }
  | { to: "offboard"; leads: LeadsChoice }
  | { to: "delete"; leads: LeadsChoice };

export type Role = {
  id: string;
  name: string;
  description: string;
  color: string;
  grants: Grant[];
  /** Only hidden and view are stored; a field not listed is editable. */
  fieldAccess: { fieldId: string; access: FieldAccessLevel }[];
  /** How many people hold the role. */
  holders: number;
  /** What else names it: invites not yet used, templates limited to it, views shared with it. */
  uses: { invites: number; templates: number; views: number };
};

/** Roles: what each can do (grants with a scope) and which fields it sees. Each returns ApiResult. */
export const rolesClient = {
  create: (input: { name: string; grants: Grant[]; color?: string }) =>
    api.post<{ role: Role }>("/api/v1/roles", input),
  patch: (id: string, patch: { name?: string; description?: string; color?: string; grants?: Grant[] }) =>
    api.patch<{ role: Role }>(`/api/v1/roles/${id}`, patch),
  clone: (id: string, name: string) => api.post<{ role: Role }>(`/api/v1/roles/${id}/clone`, { name }),
  /** The top of the hierarchy (owner 2026-11-02): the password every time, and what happens to its people. */
  remove: (
    id: string,
    o: { password: string; code?: string; people?: RolePeople; replacementRoleId?: string },
  ) => api.del<{ movedTo: string | null }>(`/api/v1/roles/${id}`, o),
  setFieldAccess: (id: string, entries: { fieldId: string; access: FieldAccessLevel }[]) =>
    api.put<{ entries: { fieldId: string; access: FieldAccessLevel }[] }>(
      `/api/v1/roles/${id}/field-access`,
      {
        entries,
      },
    ),
};
