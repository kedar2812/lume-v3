import type { PermissionKey } from "@lume/core";

/** One probe per route: how to call it with valid-looking input. Missing probe = failing CI (report §7.5). */
export type Fixtures = { userId: string; roleId: string; teamId: string; inviteToken: string };
/** What the route must require, written independently of the route code (the spec's route table). */
export type Access = "public" | "auth.self" | PermissionKey;
export type Probe = {
  access: Access;
  path?: (f: Fixtures) => string;
  body?: (f: Fixtures) => unknown;
  query?: string;
};

const uuid = "0190e0c0-0000-7000-8000-00000000abcd";
export const PROBES: Record<string, Probe> = {
  "GET /api/v1/auth/csrf": { access: "public" },
  "POST /api/v1/auth/login": {
    access: "public",
    body: () => ({ email: "nobody@test.lume", password: "not-the-password-xx" }),
  },
  "POST /api/v1/auth/2fa": { access: "public", body: () => ({ code: "000000" }) },
  "POST /api/v1/auth/recovery": { access: "public", body: () => ({ code: "AAAAA-BBBBB" }) },
  "POST /api/v1/auth/logout": { access: "auth.self" },
  "GET /api/v1/auth/me": { access: "auth.self" },
  "POST /api/v1/auth/password/forgot": { access: "public", body: () => ({ email: "nobody@test.lume" }) },
  "POST /api/v1/auth/password/reset": {
    access: "public",
    body: () => ({ token: "x".repeat(43), password: "a long and lovely passphrase" }),
  },
  "GET /api/v1/setup/status": { access: "public" },
  "POST /api/v1/setup/totp": { access: "public", body: () => ({ token: "wrong-wrong-wrong-wrong" }) },
  "POST /api/v1/setup": {
    access: "public",
    body: () => ({
      token: "wrong-wrong-wrong-wrong",
      business: { name: "X", timezone: "UTC", currency: "AED", defaultCountry: "AE" },
      preset: "general",
      owner: { name: "X", email: "x@x.com", password: "a long and lovely passphrase" },
      totp: { secret: "A".repeat(32), code: "000000" },
    }),
  },
  "GET /api/v1/me/sessions": { access: "auth.self" },
  "DELETE /api/v1/me/sessions/:id": {
    access: "auth.self",
    path: () => "/api/v1/me/sessions/0000000000000000",
  },
  "POST /api/v1/me/2fa/enrol": { access: "auth.self" },
  "POST /api/v1/me/2fa/confirm": { access: "auth.self", body: () => ({ code: "000000" }) },
  "POST /api/v1/me/2fa/disable": { access: "auth.self", body: () => ({ password: "wrong" }) },
  "POST /api/v1/me/recovery-codes": { access: "auth.self", body: () => ({ password: "wrong" }) },
  "PATCH /api/v1/me": { access: "auth.self", body: () => ({ theme: "obsidian" }) },
  "POST /api/v1/invites": {
    access: "users.manage",
    body: () => ({ email: `new-${Date.now()}@test.lume`, name: "New", roleIds: [] }),
  },
  "GET /api/v1/invites/:token": { access: "public", path: (f) => `/api/v1/invites/${f.inviteToken}` },
  "POST /api/v1/invites/:token/accept": {
    access: "public",
    path: () => `/api/v1/invites/${"x".repeat(43)}/accept`,
    body: () => ({ password: "a long and lovely passphrase" }),
  },
  "GET /api/v1/users": { access: "users.manage" },
  "PATCH /api/v1/users/:id": {
    access: "users.manage",
    path: (f) => `/api/v1/users/${f.userId}`,
    body: () => ({ name: "Renamed" }),
  },
  "POST /api/v1/users/:id/disable": { access: "users.manage", path: () => `/api/v1/users/${uuid}/disable` },
  "POST /api/v1/users/:id/enable": { access: "users.manage", path: () => `/api/v1/users/${uuid}/enable` },
  "DELETE /api/v1/users/:id/sessions": {
    access: "users.manage",
    path: (f) => `/api/v1/users/${f.userId}/sessions`,
  },
  "GET /api/v1/permissions": { access: "roles.manage" },
  "GET /api/v1/roles": { access: "roles.manage" },
  "GET /api/v1/roles/:id": { access: "roles.manage", path: (f) => `/api/v1/roles/${f.roleId}` },
  "POST /api/v1/roles": {
    access: "roles.manage",
    body: () => ({ name: `R-${Date.now()}-${Math.random()}`, grants: [] }),
  },
  "PATCH /api/v1/roles/:id": {
    access: "roles.manage",
    path: (f) => `/api/v1/roles/${f.roleId}`,
    body: () => ({ description: "d" }),
  },
  "DELETE /api/v1/roles/:id": {
    access: "roles.manage",
    path: () => `/api/v1/roles/${uuid}`,
    body: () => ({}),
  },
  "POST /api/v1/roles/:id/clone": {
    access: "roles.manage",
    path: (f) => `/api/v1/roles/${f.roleId}/clone`,
    body: () => ({ name: `C-${Date.now()}-${Math.random()}` }),
  },
  "GET /api/v1/teams": { access: "teams.manage" },
  "POST /api/v1/teams": {
    access: "teams.manage",
    body: () => ({ name: `T-${Date.now()}-${Math.random()}` }),
  },
  "PATCH /api/v1/teams/:id": {
    access: "teams.manage",
    path: (f) => `/api/v1/teams/${f.teamId}`,
    body: () => ({ name: `T2-${Date.now()}-${Math.random()}` }),
  },
  "DELETE /api/v1/teams/:id": { access: "teams.manage", path: () => `/api/v1/teams/${uuid}` },
  "PUT /api/v1/teams/:id/members": {
    access: "teams.manage",
    path: (f) => `/api/v1/teams/${f.teamId}/members`,
    body: () => ({ members: [] }),
  },
  "GET /api/v1/settings": { access: "auth.self" },
  "PATCH /api/v1/settings": { access: "settings.manage", body: () => ({ weekStart: 1 }) },
  "GET /api/v1/audit": { access: "audit.view", query: "limit=5" },
};
