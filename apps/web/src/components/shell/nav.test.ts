import { describe, expect, it } from "vitest";
import { NAV_ITEMS, activeNav, navDirection, visibleNav } from "./nav";

describe("navigation", () => {
  it("lists the spec's sections in order", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Today",
      "Leads",
      "Autopilot",
      "Pipeline",
      "Calendar",
      "Templates",
      "Media",
      "Analytics",
      "Settings",
    ]);
  });

  it("hides items the role cannot use (absent, not disabled)", () => {
    const can = (p: string) => ["leads.view", "calendar.view"].includes(p);
    expect(visibleNav(NAV_ITEMS, can).map((i) => i.id)).toEqual([
      "today",
      "leads",
      "pipeline",
      "calendar",
      "settings", // everyone has personal settings (spec §7)
    ]);
  });

  it("Media is there for whoever may use templates (plan 2026-10-20-media-tab)", () => {
    expect(visibleNav(NAV_ITEMS, (p) => p === "templates.use").map((i) => i.id)).toEqual([
      "today",
      "templates",
      "media",
      "settings",
    ]);
    expect(activeNav(NAV_ITEMS, "/media")?.id).toBe("media");
  });

  it("matches nested paths to their section", () => {
    expect(activeNav(NAV_ITEMS, "/leads/123")?.id).toBe("leads");
    expect(activeNav(NAV_ITEMS, "/nowhere")).toBeUndefined();
  });

  it("knows which way a navigation travels", () => {
    expect(navDirection(NAV_ITEMS, "/today", "/analytics")).toBe(1);
    expect(navDirection(NAV_ITEMS, "/analytics", "/leads")).toBe(-1);
    expect(navDirection(NAV_ITEMS, "/leads", "/leads/9")).toBe(0);
  });

  it("Autopilot shows for whoever may view leads, only while LUME AI is on for them (A3)", () => {
    const can = (p: string) => p === "leads.view";
    expect(visibleNav(NAV_ITEMS, can).map((i) => i.id)).not.toContain("autopilot");
    expect(visibleNav(NAV_ITEMS, can, { ai: false }).map((i) => i.id)).not.toContain("autopilot");
    expect(visibleNav(NAV_ITEMS, can, { ai: true }).map((i) => i.id)).toEqual([
      "today",
      "leads",
      "autopilot",
      "pipeline",
      "settings",
    ]);
    expect(visibleNav(NAV_ITEMS, () => false, { ai: true }).map((i) => i.id)).not.toContain("autopilot");
    expect(activeNav(NAV_ITEMS, "/autopilot")?.id).toBe("autopilot");
  });
});
