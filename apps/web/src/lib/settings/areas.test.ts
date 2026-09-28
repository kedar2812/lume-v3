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
      "fields",
      "lists",
      "follow-ups",
      "people",
      "roles",
      "teams",
      "audit",
      "account",
      "about",
    ]);
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
});
