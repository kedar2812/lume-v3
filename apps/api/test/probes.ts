import type { PermissionKey } from "@lume/core";

/** One probe per route: how to call it with valid-looking input. Missing probe = failing CI (report §7.5). */
export type Fixtures = {
  userId: string;
  roleId: string;
  teamId: string;
  inviteToken: string;
  /** Configuration and lead fixtures (Phase 1B). "…To…" ids are consumed by destructive probes. */
  leadId: string;
  leadToDelete: string;
  pipelineId: string;
  pipelineToArchive: string;
  stageId: string;
  stageToArchive: string;
  fieldId: string;
  fieldToArchive: string;
  lostReasonId: string;
  lostReasonToArchive: string;
  tagId: string;
  tagToDelete: string;
  productId: string;
  productToArchive: string;
};
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
  // Phase 1B — configuration
  "GET /api/v1/pipelines": { access: "leads.view" },
  "POST /api/v1/pipelines": {
    access: "pipelines.manage",
    body: () => ({ name: `MP-${Math.random()}`.slice(0, 30) }),
  },
  "PATCH /api/v1/pipelines/:id": {
    access: "pipelines.manage",
    path: (f) => `/api/v1/pipelines/${f.pipelineId}`,
    body: () => ({ position: 5 }),
  },
  "POST /api/v1/pipelines/:id/archive": {
    access: "pipelines.manage",
    path: (f) => `/api/v1/pipelines/${f.pipelineToArchive}/archive`,
  },
  "POST /api/v1/pipelines/:id/stages": {
    access: "pipelines.manage",
    path: (f) => `/api/v1/pipelines/${f.pipelineId}/stages`,
    body: () => ({ name: `S-${Math.random()}`.slice(0, 20), kind: "open" }),
  },
  "PUT /api/v1/pipelines/:id/stage-order": {
    access: "pipelines.manage",
    path: (f) => `/api/v1/pipelines/${f.pipelineId}/stage-order`,
    body: () => ({ stageIds: [uuid] }),
  },
  "PATCH /api/v1/stages/:id": {
    access: "pipelines.manage",
    path: (f) => `/api/v1/stages/${f.stageId}`,
    body: () => ({ color: "cyan" }),
  },
  "GET /api/v1/fields": { access: "leads.view" },
  "POST /api/v1/fields": {
    access: "fields.manage",
    body: () => ({ key: `mf_${Math.random().toString(36).slice(2, 10)}`, label: "M", type: "text" }),
  },
  "PATCH /api/v1/fields/:id": {
    access: "fields.manage",
    path: (f) => `/api/v1/fields/${f.fieldId}`,
    body: () => ({ position: 50 }),
  },
  "POST /api/v1/fields/:id/archive": {
    access: "fields.manage",
    path: (f) => `/api/v1/fields/${f.fieldToArchive}/archive`,
  },
  "GET /api/v1/lost-reasons": { access: "leads.view" },
  "POST /api/v1/lost-reasons": {
    access: "pipelines.manage",
    body: () => ({ label: `LR-${Math.random()}`.slice(0, 30) }),
  },
  "PATCH /api/v1/lost-reasons/:id": {
    access: "pipelines.manage",
    path: (f) => `/api/v1/lost-reasons/${f.lostReasonId}`,
    body: () => ({ position: 9 }),
  },
  "POST /api/v1/lost-reasons/:id/archive": {
    access: "pipelines.manage",
    path: (f) => `/api/v1/lost-reasons/${f.lostReasonToArchive}/archive`,
  },
  "GET /api/v1/tags": { access: "leads.view" },
  "POST /api/v1/tags": {
    access: "settings.manage",
    body: () => ({ label: `T-${Math.random()}`.slice(0, 30) }),
  },
  "PATCH /api/v1/tags/:id": {
    access: "settings.manage",
    path: (f) => `/api/v1/tags/${f.tagId}`,
    body: () => ({ color: "ok" }),
  },
  "DELETE /api/v1/tags/:id": { access: "settings.manage", path: (f) => `/api/v1/tags/${f.tagToDelete}` },
  "GET /api/v1/products": { access: "leads.view" },
  "POST /api/v1/products": {
    access: "settings.manage",
    body: () => ({ name: `P-${Math.random()}`.slice(0, 30) }),
  },
  "PATCH /api/v1/products/:id": {
    access: "settings.manage",
    path: (f) => `/api/v1/products/${f.productId}`,
    body: () => ({ defaultValue: 10 }),
  },
  "POST /api/v1/products/:id/archive": {
    access: "settings.manage",
    path: (f) => `/api/v1/products/${f.productToArchive}/archive`,
  },
  "PUT /api/v1/roles/:id/field-access": {
    access: "roles.manage",
    path: (f) => `/api/v1/roles/${f.roleId}/field-access`,
    body: () => ({ entries: [] }),
  },
  // Phase 1B — leads
  "GET /api/v1/leads": { access: "leads.view", query: "limit=5" },
  "POST /api/v1/leads": { access: "leads.create", body: () => ({ name: "Matrix lead" }) },
  "GET /api/v1/leads/duplicates": { access: "leads.create", query: "email=nobody%40test.lume" },
  "GET /api/v1/leads/:id": { access: "leads.view", path: (f) => `/api/v1/leads/${f.leadId}` },
  "PATCH /api/v1/leads/:id": {
    access: "leads.edit",
    path: (f) => `/api/v1/leads/${f.leadId}`,
    body: () => ({ name: "Renamed" }),
  },
  "DELETE /api/v1/leads/:id": { access: "leads.delete", path: (f) => `/api/v1/leads/${f.leadToDelete}` },
  "POST /api/v1/stages/:id/archive": {
    access: "pipelines.manage",
    path: (f) => `/api/v1/stages/${f.stageToArchive}/archive`,
    body: () => ({}),
  },
};
