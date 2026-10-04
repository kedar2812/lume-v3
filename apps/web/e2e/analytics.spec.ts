import AxeBuilder from "@axe-core/playwright";
import { rollupAnalytics } from "./db";
import { expect, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * Analytics (8C) on the real stack: the seeded business's numbers, rolled up as the API's clock keeps them, read on
 * every board in both themes; a number opens its leads; nothing an accessibility check flags.
 */
test.describe("Analytics (8C)", () => {
  test.use({ storageState: stateFile("owner") });

  test("every board in both themes, and a number opens the leads behind it", async ({ browser }) => {
    await rollupAnalytics();
    for (const theme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({
        storageState: stateFile("owner"),
        colorScheme: theme,
        reducedMotion: "reduce",
        viewport: { width: 1440, height: 900 },
      });
      const page = await ctx.newPage();
      await openApp(page, "/analytics");
      await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: /^New leads: / })).toBeVisible();
      await settle(page);
      await reviewCopy(page, `overview-${theme}.png`);
      const axe = (await new AxeBuilder({ page }).analyze()).violations.map(
        (v) => `${v.id}: ${v.nodes[0]?.target}`,
      );
      expect(axe).toEqual([]);
      await page.getByRole("button", { name: /^New leads: .*See the leads/ }).click();
      await expect(page.getByRole("dialog", { name: /The leads behind it/ })).toBeVisible();
      await settle(page);
      await reviewCopy(page, `drill-${theme}.png`);
      await page.keyboard.press("Escape");
      for (const tab of ["Funnel", "Team", "Revenue & sources", "Lost", "Timing", "Templates & data"]) {
        await page.getByRole("tab", { name: tab }).click();
        await expect(page.getByRole("tabpanel", { name: tab })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await settle(page);
        await reviewCopy(page, `${tab.toLowerCase().replace(/[^a-z]+/g, "-")}-${theme}.png`);
      }
      await ctx.close();
    }
  });
});
