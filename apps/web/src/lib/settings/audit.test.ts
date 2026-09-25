import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, auditPhrase, type AuditEntry } from "./audit";

const people = [
  { id: "u-riya", name: "Riya Sharma", active: true },
  { id: "u-tas", name: "Tasneem Shaikh", active: true },
];
const entry = (action: string, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1,
  at: "2026-09-25T10:00:00Z",
  actorUserId: "u-riya",
  actorIp: null,
  action,
  entityType: "lead",
  entityId: "l1",
  diff: {},
  ...over,
});

/** Every action the API writes today (grep `action: "` in apps/api/src). A new one must be phrased here too. */
const WRITTEN = [
  "field.archived",
  "field.created",
  "field.updated",
  "invite.resent",
  "invite.revoked",
  "lead.assign",
  "lead.bulk",
  "lead.contact.reveal",
  "lead.create",
  "lead.delete",
  "lead.stage",
  "lead.update",
  "lead.view",
  "lead.whatsapp.prepare",
  "lost_reason.archived",
  "lost_reason.created",
  "lost_reason.updated",
  "pipeline.archived",
  "pipeline.created",
  "pipeline.updated",
  "product.archived",
  "product.created",
  "product.updated",
  "role.created",
  "role.deleted",
  "role.field_access.updated",
  "role.updated",
  "session.revoked",
  "session.revoked_all",
  "settings.currency.changed",
  "settings.updated",
  "setup.completed",
  "stage.archived",
  "stage.created",
  "stage.reordered",
  "stage.updated",
  "tag.created",
  "tag.deleted",
  "tag.updated",
  "team.created",
  "team.deleted",
  "team.members.set",
  "team.renamed",
  "user.agreed",
  "user.invite.accepted",
  "user.invited",
  "user.login",
  "user.login.password_ok",
  "user.logout",
  "user.onboarding.completed",
  "user.password.reset",
  "user.password.reset_requested",
  "user.profile.updated",
  "user.recovery_codes.regenerated",
  "user.updated",
  "user.disabled",
  "user.enabled",
  "user.2fa.enabled",
  "user.2fa.disabled",
  "user.2fa.failed",
  "user.login.failed",
  "user.login.locked",
];

describe("auditPhrase", () => {
  it.each(WRITTEN)("phrases %s in words", (action) => {
    expect(AUDIT_ACTIONS[action], action).toBeDefined();
    const phrase = auditPhrase(entry(action), people);
    expect(phrase).toMatch(/^Riya Sharma /);
    expect(phrase).not.toContain(action);
  });

  it("names the person, or says LUME for the system and Someone for a person no longer listed", () => {
    expect(auditPhrase(entry("lead.contact.reveal"), people)).toBe("Riya Sharma revealed a lead’s contact");
    expect(auditPhrase(entry("setup.completed", { actorUserId: null }), people)).toBe(
      "LUME finished first-run setup",
    );
    expect(auditPhrase(entry("lead.view", { actorUserId: "u-gone" }), people)).toBe("Someone opened a lead");
  });

  it("adds the detail the entry carries where it helps", () => {
    expect(
      auditPhrase(
        entry("settings.currency.changed", { diff: { from: "AED", to: "USD", rate: 0.27 } }),
        people,
      ),
    ).toBe("Riya Sharma changed the currency from AED to USD at 0.27");
    expect(
      auditPhrase(entry("lead.bulk", { diff: { type: "assign", updated: 12, skipped: 0 } }), people),
    ).toBe("Riya Sharma changed 12 leads at once");
  });

  it("falls back to the raw action for one it doesn't know yet", () => {
    expect(auditPhrase(entry("widget.frobbed"), people)).toBe("Riya Sharma: widget.frobbed");
  });
});
