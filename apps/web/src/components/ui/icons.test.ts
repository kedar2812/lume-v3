import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UI_ICONS } from "./icons";

/**
 * LUME's icons (docs/design/icons.md): a screen takes its icons from the registry, never draws its own. Moved over
 * screen by screen; an area once moved keeps only the drawings that aren't icons (progress rings, the Refresh morph) or
 * wait for a meaning, named here, so a new hand-drawn icon can't creep back in.
 */
const components = resolve(import.meta.dirname, "..");
function drawn(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) {
        const n = (readFileSync(p, "utf8").match(/<svg\b/g) ?? []).length;
        if (n) out[relative(components, p).replace(/\\/g, "/")] = n;
      }
    }
  };
  walk(join(components, dir));
  return out;
}

describe("LUME's icons come from the registry (2026-11-27 sweep)", () => {
  it("Leads draws only what isn't an icon, or what waits for its meaning", () => {
    expect(drawn("leads")).toEqual({
      // The meeting's countdown ring.
      "leads/drawer/NextMeeting.tsx": 1,
      // The live progress rings, and Hide (waiting for its meaning).
      "leads/island/Island.tsx": 3,
      // The Refresh morph (LUME's own, kept).
      "leads/ReloadRefresh.tsx": 1,
      // The live run's ring and the window's ring.
      "leads/runs/RunsDrawer.tsx": 2,
    });
  });

  it("Settings draws only what isn't an icon, or what waits for its meaning", () => {
    expect(drawn("settings")).toEqual({
      // A file that couldn't be read (waiting for its meaning).
      "settings/ai/KnowsSection.tsx": 1,
      // A meeting's calendar and busy marks (waiting for their meaning).
      "settings/CalendarRules.tsx": 2,
      // The goal's progress ring.
      "settings/GoalsEditor.tsx": 1,
      // Who is told (waiting for its meaning: Users is the sidebar's Leads).
      "settings/security/RulesTab.tsx": 1,
      // The clean-up morph and the system health morph (LUME's own, kept).
      "settings/storage/CleanUpMorph.tsx": 2,
      "settings/SystemHealth.tsx": 1,
    });
  });

  it("Analytics and Calendar draw their charts, rings and morphs, and what waits for its meaning", () => {
    expect(drawn("analytics")).toEqual({
      "analytics/AnalyticsRefresh.tsx": 1, // the Refresh morph
      "analytics/FunnelBoard.tsx": 2, // the funnel's ribbon, and its step arrow
      "analytics/InstagramBoard.tsx": 1, // a chart
      "analytics/LostBoard.tsx": 1, // a ring
      "analytics/Overview.tsx": 2, // a chart and the goal's ring
      "analytics/parts.tsx": 3, // the trend arrows, and Go (waiting for its meaning)
      "analytics/QualityBoard.tsx": 3, // a ring, and two tiles waiting for their meaning
      "analytics/RepNumbers.tsx": 1, // a ring
      "analytics/RevenueBoard.tsx": 2, // a chart and a ring
      "analytics/TeamBoard.tsx": 2, // a ring and a sort arrow
    });
    expect(drawn("calendar")).toEqual({
      "calendar/CalendarRefresh.tsx": 1, // the Refresh morph
      "calendar/CalendarScreen.tsx": 3, // the views' marks and the arrows, waiting for their meaning
      "calendar/ConnectCalendar.tsx": 2, // the animated tick, and each provider's mark
      "calendar/LogOutcome.tsx": 1, // each outcome's mark
      "calendar/PhoneCalendar.tsx": 5, // the phone tiles, waiting for their meaning, and Copy's morph
      "calendar/ScheduleMeeting.tsx": 1, // Google Meet's mark
    });
  });

  it("across LUME, drawings only ever go down (a ratchet: lower it as each screen moves over)", () => {
    const all = Object.values(drawn(".")).reduce((a, b) => a + b, 0);
    expect(all).toBeLessThanOrEqual(120);
  });

  it("one meaning, one name: every registry entry is a component", () => {
    for (const [k, v] of Object.entries(UI_ICONS)) expect(v, k).toBeTruthy();
  });
});
