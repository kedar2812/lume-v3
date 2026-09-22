import { describe, expect, it } from "vitest";
import { PERMISSIONS, isPermissionKey } from "./catalog";
import { DEFAULT_ROLES } from "./defaults";
import {
  can,
  canOnRecord,
  effectivePermissions,
  leadScope,
  requiresTwoFactor,
  scopeOf,
  type Actor,
} from "./engine";

const actor = (grants: Parameters<typeof effectivePermissions>[0], extra: Partial<Actor> = {}): Actor => ({
  userId: "u1",
  isOwner: false,
  perms: effectivePermissions(grants),
  teamMemberIds: [],
  twoFactorEnabled: false,
  roleIds: [],
  ...extra,
});

describe("catalog (report §7.2)", () => {
  it("has unique, well-formed keys and the report's scoped set", () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    const scoped = PERMISSIONS.filter((p) => p.scoped)
      .map((p) => p.key)
      .sort();
    expect(scoped).toEqual([
      "analytics.view",
      "calendar.view",
      "leads.assign",
      "leads.bulk_edit",
      "leads.change_stage",
      "leads.contact.full",
      "leads.contact.reveal",
      "leads.delete",
      "leads.edit",
      "leads.export",
      "leads.view",
      "messages.send",
      "messages.send_queue",
      "tasks.manage_others",
    ]);
    expect(isPermissionKey("leads.view")).toBe(true);
    expect(isPermissionKey("leads.steal")).toBe(false);
  });
});

describe("effective permissions", () => {
  it("unions roles and keeps the widest scope", () => {
    const a = actor([
      { key: "leads.view", scope: "own" },
      { key: "leads.view", scope: "team" },
      { key: "leads.view", scope: "own" },
      { key: "templates.use", scope: null },
    ]);
    expect(scopeOf(a, "leads.view")).toBe("team");
    expect(can(a, "leads.view", "own")).toBe(true);
    expect(can(a, "leads.view", "all")).toBe(false);
    expect(can(a, "templates.use")).toBe(true);
    expect(can(a, "leads.export")).toBe(false);
    expect(leadScope(a)).toBe("team");
  });

  it("gives the owner everything, with all scope", () => {
    const o = actor([], { isOwner: true });
    expect(can(o, "security.manage")).toBe(true);
    expect(scopeOf(o, "leads.view")).toBe("all");
    expect(leadScope(o)).toBe("all");
  });

  it("has no lead scope without leads.view", () => {
    expect(leadScope(actor([{ key: "templates.use", scope: null }]))).toBeNull();
  });
});

describe("mandatory two-factor (report §12.1)", () => {
  it.each([
    [[{ key: "users.manage", scope: null }], true],
    [[{ key: "roles.manage", scope: null }], true],
    [[{ key: "leads.export", scope: "own" }], true],
    [[{ key: "security.manage", scope: null }], true],
    [[{ key: "leads.contact.full", scope: "all" }], true],
    [[{ key: "leads.contact.full", scope: "own" }], false],
    [[{ key: "leads.view", scope: "all" }], false],
  ] as const)("%j → %s", (grants, expected) => {
    expect(requiresTwoFactor(actor([...grants]))).toBe(expected);
  });
  it("always applies to the owner", () => expect(requiresTwoFactor(actor([], { isOwner: true }))).toBe(true));
});

describe("seeded roles", () => {
  it("Admin has every permission at all scope", () => {
    const admin = DEFAULT_ROLES.find((r) => r.name === "Admin")!;
    expect(admin.grants).toHaveLength(PERMISSIONS.length);
    for (const g of admin.grants)
      expect(g.scope).toBe(PERMISSIONS.find((p) => p.key === g.key)!.scoped ? "all" : null);
  });

  it("Sales matches report §7.3 exactly: reveal, never full contact, no export/assign/delete", () => {
    const sales = DEFAULT_ROLES.find((r) => r.name === "Sales")!;
    expect(Object.fromEntries(sales.grants.map((g) => [g.key, g.scope]))).toEqual({
      "leads.view": "own",
      "leads.edit": "own",
      "leads.change_stage": "own",
      "leads.contact.reveal": "own",
      "messages.send": "own",
      "templates.use": null,
      "calendar.view": "own",
      "calendar.connect": null,
      "analytics.view": "own",
    });
  });
});

describe("canOnRecord (scoped write checks)", () => {
  const rep = actor(
    [
      { key: "leads.edit", scope: "own" },
      { key: "leads.assign", scope: "team" },
    ],
    { userId: "me", teamMemberIds: ["me", "m2"] },
  );
  it("own scope covers only my records, team adds my team's, nothing covers unassigned below all", () => {
    expect(canOnRecord(rep, "leads.edit", "me")).toBe(true);
    expect(canOnRecord(rep, "leads.edit", "m2")).toBe(false);
    expect(canOnRecord(rep, "leads.assign", "m2")).toBe(true);
    expect(canOnRecord(rep, "leads.assign", "stranger")).toBe(false);
    expect(canOnRecord(rep, "leads.assign", null)).toBe(false);
    expect(canOnRecord(rep, "leads.delete", "me")).toBe(false);
  });
  it("all scope and the owner cover everything", () => {
    expect(canOnRecord(actor([{ key: "leads.edit", scope: "all" }]), "leads.edit", null)).toBe(true);
    expect(canOnRecord(actor([], { isOwner: true }), "leads.delete", "anyone")).toBe(true);
  });
});
