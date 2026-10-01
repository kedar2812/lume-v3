import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, auditPhrase, type AuditEntry } from "./audit";

const people = [
  { id: "u-riya", name: "Riya Sharma", active: true },
  { id: "u-tas", name: "Leila Haddad", active: true },
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
  "calendar.connected",
  "calendar.reconnected",
  "calendar.calendars_changed",
  "calendar.disconnected",
  "calendar.needs_reconnect",
  "import.cancelled",
  "import.discarded",
  "import.failed",
  "import.finished",
  "import.resumed",
  "import.started",
  "import.stopped",
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
  "lost_reason.reordered",
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
  "stage.automations",
  "template.created",
  "template.updated",
  "template.archived",
  "template.reordered",
  "template.restored",
  "view.created",
  "view.updated",
  "view.deleted",
  "view.restored",
  "settings.follow_ups",
  "settings.messaging",
  "queue.started",
  "queue.paused",
  "queue.resumed",
  "queue.cancelled",
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
  it("4B: says what happened to a saved view", () => {
    const say = (action: string, diff: Record<string, unknown>) =>
      auditPhrase(entry(action, { entityType: "view", diff }), people);
    expect(say("view.created", { name: "No reply 3+ days" })).toBe(
      "Riya Sharma saved the view “No reply 3+ days”",
    );
    expect(say("view.updated", { name: "No reply 3+ days" })).toBe(
      "Riya Sharma changed the view “No reply 3+ days”",
    );
    expect(say("view.deleted", { name: "No reply 3+ days" })).toBe(
      "Riya Sharma deleted the view “No reply 3+ days”",
    );
    expect(say("view.restored", { name: "No reply 3+ days" })).toBe(
      "Riya Sharma put back the view “No reply 3+ days”",
    );
  });

  it("4A: says what happened to a template, and when its words changed", () => {
    const say = (action: string, diff: Record<string, unknown>) =>
      auditPhrase(entry(action, { entityType: "template", diff }), people);
    expect(say("template.created", { name: "Gentle nudge" })).toBe(
      "Riya Sharma added the template “Gentle nudge”",
    );
    expect(say("template.updated", { name: "Gentle nudge", newVersion: true })).toBe(
      "Riya Sharma changed the words of “Gentle nudge”",
    );
    expect(say("template.updated", { name: "Gentle nudge" })).toBe(
      "Riya Sharma changed the template “Gentle nudge”",
    );
    expect(say("template.archived", { name: "Gentle nudge" })).toBe(
      "Riya Sharma archived the template “Gentle nudge”",
    );
    expect(say("template.reordered", {})).toBe("Riya Sharma reordered the templates");
  });

  it("4C: says what changed in Settings → Messages", () => {
    const say = (diff: Record<string, unknown>) =>
      auditPhrase(entry("settings.messaging", { entityType: "settings", diff }), people);
    expect(say({ queueSize: 80 })).toBe("Riya Sharma set send queues to 80 leads a run");
    expect(say({ dailyCap: 300 })).toBe("Riya Sharma set the daily limit to 300 queued messages a person");
    expect(say({ queueSize: 40, dailyCap: 120 })).toBe(
      "Riya Sharma set send queues to 40 leads a run, and the daily limit to 120 queued messages a person",
    );
  });

  it("4C: a send queue started, paused, resumed and ended", () => {
    const say = (action: string, diff: Record<string, unknown>) =>
      auditPhrase(entry(action, { entityType: "send_queue", diff }), people);
    expect(say("queue.started", { source: "No reply 3+ days", leads: 12 })).toBe(
      "Riya Sharma started a send queue of 12 leads from “No reply 3+ days”",
    );
    expect(say("queue.started", { source: "Your selection", leads: 1 })).toBe(
      "Riya Sharma started a send queue of 1 lead from “Your selection”",
    );
    expect(say("queue.paused", {})).toBe("Riya Sharma paused a send queue");
    expect(say("queue.resumed", {})).toBe("Riya Sharma resumed a send queue");
    expect(say("queue.cancelled", { sent: 7 })).toBe("Riya Sharma ended a send queue after 7 messages");
  });

  it("3C: says which part of Settings → Follow-ups changed, and a stage's automations", () => {
    const say = (diff: Record<string, unknown>) =>
      auditPhrase(entry("settings.follow_ups", { entityType: "settings", diff }), people);
    expect(say({ escalation: { enabled: true, hours: 6 } })).toBe(
      "Riya Sharma set overdue follow-ups to reach managers after 6 hours",
    );
    expect(say({ digest: { enabled: false } })).toBe("Riya Sharma switched off the morning email");
    expect(say({ noTouch: { enabled: true, days: 10 } })).toBe(
      "Riya Sharma set leads gone quiet to come back after 10 days",
    );
    expect(say({ shiftToWorkingHours: false, duePresets: [] })).toBe(
      "Riya Sharma let LUME's follow-ups fall outside working hours; changed the time choices",
    );
    expect(
      auditPhrase(entry("stage.automations", { entityType: "stage", diff: { rules: [{}, {}] } }), people),
    ).toBe("Riya Sharma changed a stage's automations (2)");
  });

  it("says what an import did", () => {
    expect(
      auditPhrase(entry("import.finished", { diff: { created: 812, merged: 40, errors: 3 } }), people),
    ).toBe("Riya Sharma imported leads: 812 created, 40 merged, 3 with problems");
  });

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

  it("prefers the name the entry carries, so the log reads without the people list", () => {
    expect(auditPhrase(entry("lead.view", { actorUserId: "u-new", actorName: "Omar Test" }), [])).toBe(
      "Omar Test opened a lead",
    );
  });

  it("falls back to the raw action for one it doesn't know yet", () => {
    expect(auditPhrase(entry("widget.frobbed"), people)).toBe("Riya Sharma: widget.frobbed");
  });
});
