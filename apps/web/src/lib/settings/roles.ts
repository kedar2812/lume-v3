"use client";
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
};

/** Roles: what each can do (grants with a scope) and which fields it sees. Each returns ApiResult. */
export const rolesClient = {
  create: (input: { name: string; grants: Grant[]; color?: string }) =>
    api.post<{ role: Role }>("/api/v1/roles", input),
  patch: (id: string, patch: { name?: string; description?: string; color?: string; grants?: Grant[] }) =>
    api.patch<{ role: Role }>(`/api/v1/roles/${id}`, patch),
  clone: (id: string, name: string) => api.post<{ role: Role }>(`/api/v1/roles/${id}/clone`, { name }),
  remove: (id: string, replacementRoleId?: string) =>
    api.del<null>(`/api/v1/roles/${id}`, replacementRoleId ? { replacementRoleId } : undefined),
  setFieldAccess: (id: string, entries: { fieldId: string; access: FieldAccessLevel }[]) =>
    api.put<{ entries: { fieldId: string; access: FieldAccessLevel }[] }>(
      `/api/v1/roles/${id}/field-access`,
      {
        entries,
      },
    ),
};
