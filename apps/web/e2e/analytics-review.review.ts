import pg from "pg";
import { roleUrl } from "@lume/db";
import { seedDemoBusiness } from "../../api/src/demo/seed";
import { expect, openApp, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * Analytics, reviewed full (8D spec §2.3): the made-up demo business (six months of natural data, 8D-1) seeded into the
 * e2e installation, then every board in both themes, at the canvas's 1440 × 900 and the owner's 1366 × 800, plus a
 * tall copy that shows each whole board. Run on request only (LUME_REVIEW=1 playwright test --project analytics-review);
 * the copies land in e2e/__review__/analytics-review/ to sit beside docs/design/phase8/screens.
 */
test.describe("analytics review", () => {
  test.use({ storageState: stateFile("owner") });
  test.setTimeout(900_000);

  test("the demo business on every board", async ({ browser }) => {
    const pool = new pg.Pool({ connectionString: roleUrl("lume_owner", "lume_e2e") });
    try {
      await seedDemoBusiness(pool, { now: new Date(), seed: 11, demoMode: true });
    } finally {
      await pool.end();
    }
    const tabs = ["Overview", "Funnel", "Team", "Revenue & sources", "Lost", "Timing", "Templates & data"];
    const sizes = [
      { w: 1440, h: 900, tag: "1440" },
      { w: 1366, h: 800, tag: "1366" },
      { w: 1440, h: 2400, tag: "full" },
    ];
    for (const theme of ["light", "dark"] as const)
      for (const size of sizes) {
        const ctx = await browser.newContext({
          storageState: stateFile("owner"),
          colorScheme: theme,
          reducedMotion: "reduce",
          viewport: { width: size.w, height: size.h },
        });
        const page = await ctx.newPage();
        await openApp(page, "/analytics?range=30d");
        await expect(page.getByRole("tablist", { name: "Analytics" })).toBeVisible();
        for (const tab of tabs) {
          const t = page.getByRole("tab", { name: tab });
          if (!(await t.count())) continue;
          await t.click();
          await expect(page.getByRole("tabpanel", { name: tab })).toBeVisible();
          await page.waitForLoadState("networkidle");
          await settle(page);
          const name = tab.toLowerCase().replace(/[^a-z]+/g, "-");
          await page.screenshot({
            path: `e2e/__review__/analytics-review/${name}-${theme}-${size.tag}.png`,
            animations: "disabled",
          });
        }
        // 8D-3: Settings → Goals and Sources & spend, and Log a call open in a lead's drawer.
        for (const [path, name] of [
          ["/settings/goals", "goals"],
          ["/settings/sources", "spend"],
        ] as const) {
          await openApp(page, path);
          await page.waitForLoadState("networkidle");
          await settle(page);
          await page.screenshot({
            path: `e2e/__review__/analytics-review/${name}-${theme}-${size.tag}.png`,
            animations: "disabled",
          });
        }
        await openApp(page, "/leads");
        await page.getByRole("row").nth(1).click();
        await page.getByRole("button", { name: "Log a call (C)" }).click();
        await expect(page.getByRole("dialog", { name: "Log a call" })).toBeVisible();
        await settle(page);
        await page.screenshot({
          path: `e2e/__review__/analytics-review/logcall-${theme}-${size.tag}.png`,
          animations: "disabled",
        });
        await ctx.close();
      }
  });
});
