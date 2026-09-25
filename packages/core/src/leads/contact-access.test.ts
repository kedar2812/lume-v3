import { describe, expect, it } from "vitest";
import type { PermissionKey, Scope } from "../rbac/catalog";
import { effectivePermissions, type Actor } from "../rbac/engine";
import { seesFullContacts } from "./contact-access";

const actor = (grants: { key: PermissionKey; scope: Scope | null }[], isOwner = false): Actor => ({
  userId: "u",
  isOwner,
  perms: effectivePermissions(grants),
  teamMemberIds: [],
  twoFactorEnabled: true,
  roleIds: [],
});

describe("seesFullContacts", () => {
  it("is true for the owner and for full contacts at least as wide as what they can view", () => {
    expect(seesFullContacts(actor([], true))).toBe(true);
    expect(
      seesFullContacts(
        actor([
          { key: "leads.view", scope: "all" },
          { key: "leads.contact.full", scope: "all" },
        ]),
      ),
    ).toBe(true);
    expect(
      seesFullContacts(
        actor([
          { key: "leads.view", scope: "own" },
          { key: "leads.contact.full", scope: "team" },
        ]),
      ),
    ).toBe(true);
  });

  it("is false for a masked role, and for full contacts narrower than the view", () => {
    expect(
      seesFullContacts(
        actor([
          { key: "leads.view", scope: "own" },
          { key: "leads.contact.reveal", scope: "own" },
        ]),
      ),
    ).toBe(false);
    expect(
      seesFullContacts(
        actor([
          { key: "leads.view", scope: "all" },
          { key: "leads.contact.full", scope: "own" },
        ]),
      ),
    ).toBe(false);
    expect(seesFullContacts(actor([]))).toBe(false);
  });
});
