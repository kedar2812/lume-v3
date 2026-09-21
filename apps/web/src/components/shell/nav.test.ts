import { describe, expect, it } from "vitest";
import { NAV_ITEMS, activeNav, navDirection, visibleNav } from "./nav";

describe("navigation", () => {
  it("lists the spec's sections in order", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Today",
      "Leads",
      "Pipeline",
      "Calendar",
      "Templates",
      "Analytics",
      "Settings",
    ]);
  });

  it("hides items the role cannot use (absent, not disabled)", () => {
    const can = (p: string) => ["leads.view", "calendar.view"].includes(p);
    expect(visibleNav(NAV_ITEMS, can).map((i) => i.id)).toEqual(["today", "leads", "pipeline", "calendar"]);
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
});
