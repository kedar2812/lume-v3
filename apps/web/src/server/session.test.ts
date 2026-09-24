import { describe, expect, it } from "vitest";
import { toSession, type MePayload } from "./session";

const payload: MePayload = {
  user: { id: "u1", name: "Riya", email: "r@x.com", isOwner: false, theme: "system", timezone: "Asia/Dubai" },
  permissions: [
    { key: "leads.view", scope: "team" },
    { key: "templates.use", scope: null },
  ],
  twoFactor: { enabled: false, required: false },
  preferences: {
    workingDays: [1],
    workStart: "09:00",
    workEnd: "18:00",
    digestTime: "08:00",
    sounds: { enabled: true, volume: 60 },
    alerts: { assigned: true, dueFollowUps: true, emailDigest: true },
  },
  onboarding: { step: null, skipped: [], completedAt: null },
  tour: { version: 0, step: 0, completedAt: null, skippedAt: null },
  capabilities: { sheets: false, calendar: false },
  flags: { needsOnboarding: true, needsTwoFactorEnrolment: false, needsTour: true },
};

describe("session", () => {
  it("builds an actor whose scopes match what the API sent", () => {
    const s = toSession(payload);
    expect(s.actor.perms.get("leads.view")).toBe("team");
    expect(s.actor.perms.get("templates.use")).toBe(true);
    expect(s.actor.isOwner).toBe(false);
    expect(s.actor.twoFactorEnabled).toBe(false);
  });

  it("ignores permission keys it doesn't know (a newer API)", () => {
    const s = toSession({
      ...payload,
      permissions: [...payload.permissions, { key: "leads.timetravel", scope: "all" }],
    });
    expect([...s.actor.perms.keys()]).toEqual(["leads.view", "templates.use"]);
  });
});
