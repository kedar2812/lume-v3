import pg from "pg";
import type { Page } from "@playwright/test";
import { roleUrl } from "@lume/db";
import { DemoSeedRefused, seedDemoBusiness } from "../../api/src/demo/seed";
import { openApp, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * Phase 9 Task 1, the design audit: every screen the approved canvases drew (Phases 5–7, and the screens around
 * them), captured on the demo business in both themes at the canvas's 1440 × 900 — and the phone board at 390 —
 * into e2e/__review__/design-review/, to sit beside docs/design/phase{5,6,7}/screens. On request only:
 * LUME_REVIEW=1 playwright test --project design-review. A screen that can't be reached is skipped and named, never
 * stops the rest.
 */
type Shot = { name: string; path: string; then?: (page: Page) => Promise<void> };
const SHOTS: Shot[] = [
  { name: "today", path: "/today" },
  { name: "leads", path: "/leads" },
  {
    name: "leads-selected",
    path: "/leads",
    then: async (page) => {
      await page
        .getByRole("checkbox", { name: /^Select all/ })
        .first()
        .click();
    },
  },
  {
    name: "drawer",
    path: "/leads",
    then: async (page) => {
      await page.getByRole("row").nth(1).click();
      await page.getByRole("dialog").first().waitFor();
    },
  },
  {
    name: "search",
    path: "/leads",
    then: async (page) => {
      await page.keyboard.press("Control+k");
      await page.keyboard.type("an");
    },
  },
  { name: "pipeline", path: "/pipeline" },
  { name: "calendar", path: "/calendar" },
  { name: "templates", path: "/templates" },
  { name: "settings-calendar", path: "/settings/calendar" },
  { name: "settings-calendar-rules", path: "/settings/calendar/rules" },
  { name: "settings-integrations", path: "/settings/integrations" },
  { name: "settings-pipeline", path: "/settings/pipeline" },
  { name: "settings-people", path: "/settings/people" },
  { name: "settings-security", path: "/settings/security" },
  { name: "settings-security-rules", path: "/settings/security/rules" },
  { name: "settings-security-access", path: "/settings/security/access" },
  { name: "settings-security-exports", path: "/settings/security/exports" },
  { name: "settings-account", path: "/settings/account" },
  { name: "settings-follow-ups", path: "/settings/follow-ups" },
  {
    name: "notifications",
    path: "/today",
    then: async (page) => page.getByRole("button", { name: /Notifications/ }).click(),
  },
];

test.describe("design review", () => {
  test.use({ storageState: stateFile("owner") });
  test.setTimeout(1_800_000);

  test("every canvas screen, both themes", async ({ browser }) => {
    const pool = new pg.Pool({ connectionString: roleUrl("lume_owner", "lume_e2e") });
    try {
      await seedDemoBusiness(pool, { now: new Date(), seed: 11, demoMode: true });
    } catch (e) {
      // Already seeded by another review in this run: the same business either way.
      if (!(e instanceof DemoSeedRefused)) throw e;
    } finally {
      await pool.end();
    }
    const skipped: string[] = [];
    for (const theme of ["light", "dark"] as const) {
      for (const size of [
        { w: 1440, h: 900, tag: "1440" },
        { w: 390, h: 844, tag: "phone" },
      ]) {
        const ctx = await browser.newContext({
          storageState: stateFile("owner"),
          colorScheme: theme,
          reducedMotion: "reduce",
          viewport: { width: size.w, height: size.h },
        });
        const page = await ctx.newPage();
        for (const shot of size.tag === "phone"
          ? SHOTS.filter((x) => ["calendar", "today", "leads"].includes(x.name))
          : SHOTS) {
          try {
            await openApp(page, shot.path);
            await page.waitForLoadState("networkidle");
            if (shot.then) await shot.then(page);
            await settle(page);
            await page.screenshot({
              path: `e2e/__review__/design-review/${shot.name}-${theme}-${size.tag}.png`,
              animations: "disabled",
            });
          } catch (e) {
            skipped.push(`${shot.name} (${theme}, ${size.tag}): ${(e as Error).message.split("\n")[0]}`);
          }
        }
        await ctx.close();
      }
    }
    console.log(`design review skipped ${skipped.length}:\n${skipped.join("\n")}`);
  });
});
