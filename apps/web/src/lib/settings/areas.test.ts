import { describe, expect, it } from "vitest";
import { fakeSession } from "@/server/session";
import { areasFor } from "./areas";

describe("areasFor", () => {
  it("shows a sales rep only their own settings", () => {
    const rep = fakeSession({ permissions: [{ key: "leads.view", scope: "own" }] });
    expect(areasFor(rep.actor).map((a) => a.id)).toEqual(["account", "about"]);
  });

  it("shows an admin every area their permissions reach, in the home's order", () => {
    const admin = fakeSession({
      permissions: [
        { key: "settings.manage", scope: null },
        { key: "pipelines.manage", scope: null },
        { key: "fields.manage", scope: null },
        { key: "users.manage", scope: null },
        { key: "roles.manage", scope: null },
        { key: "teams.manage", scope: null },
        { key: "audit.view", scope: null },
      ],
    });
    expect(areasFor(admin.actor).map((a) => a.id)).toEqual([
      "business",
      "pipeline",
      "calendar-rules",
      "fields",
      "lists",
      "follow-ups",
      "goals",
      "sources",
      "messages",
      "health",
      "ai",
      "people",
      "roles",
      "teams",
      "audit",
      "account",
      "about",
    ]);
  });

  it("LUME AI (Autopilot A1): for whoever manages settings, straight after Integrations; never for a rep", () => {
    const admin = fakeSession({
      permissions: [
        { key: "settings.manage", scope: null },
        { key: "integrations.manage", scope: null },
      ],
    });
    const ids = areasFor(admin.actor).map((a) => a.id);
    expect(ids.indexOf("ai")).toBe(ids.indexOf("integrations") + 1);
    const ai = areasFor(admin.actor).find((a) => a.id === "ai")!;
    expect([ai.title, ai.href]).toEqual(["LUME AI", "/settings/ai"]);
    const rep = fakeSession({ permissions: [{ key: "leads.view", scope: "own" }] });
    expect(areasFor(rep.actor).map((a) => a.id)).not.toContain("ai");
  });

  it("shows Calendar to whoever may connect their own, among their own settings", () => {
    const rep = fakeSession({ permissions: [{ key: "calendar.connect", scope: null }] });
    expect(areasFor(rep.actor).map((a) => a.id)).toEqual(["calendar", "account", "about"]);
  });

  it("shows Imports to whoever may import leads", () => {
    const importer = fakeSession({ permissions: [{ key: "leads.import", scope: null }] });
    expect(areasFor(importer.actor).map((a) => a.id)).toEqual(["imports", "account", "about"]);
  });

  it("shows Integrations to whoever may manage integrations", () => {
    const integrator = fakeSession({ permissions: [{ key: "integrations.manage", scope: null }] });
    expect(areasFor(integrator.actor).map((a) => a.id)).toEqual(["integrations", "account", "about"]);
  });

  it("opens the lists to whoever may change any of them", () => {
    const pipelinesOnly = fakeSession({ permissions: [{ key: "pipelines.manage", scope: null }] });
    expect(areasFor(pipelinesOnly.actor).map((a) => a.id)).toContain("lists");
  });

  it("Media is a sidebar page; Settings keeps a card that opens it, for whoever manages the files (2026-10-20)", () => {
    const admin = fakeSession({ permissions: [{ key: "templates.manage", scope: null }] });
    const media = areasFor(admin.actor).find((a) => a.id === "media");
    expect(media).toMatchObject({ title: "Media", href: "/media" });
    expect(areasFor(admin.actor).map((a) => a.id)).not.toContain("files");
  });

  it("6A: Security, after Teams and before the Audit log, only for people who manage security", () => {
    const sec = fakeSession({
      permissions: [
        { key: "teams.manage", scope: null },
        { key: "security.manage", scope: null },
        { key: "audit.view", scope: null },
      ],
    });
    expect(areasFor(sec.actor).map((a) => a.id)).toEqual(["teams", "security", "audit", "account", "about"]);
    const rep = fakeSession({ permissions: [{ key: "leads.view", scope: "own" }] });
    expect(areasFor(rep.actor).map((a) => a.id)).not.toContain("security");
  });
});
