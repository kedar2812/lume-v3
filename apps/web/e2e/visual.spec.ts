import { expect, test } from "@playwright/test";
import { settle } from "./settle";

for (const theme of ["porcelain", "obsidian"] as const) {
  test.describe(theme, () => {
    test.beforeEach(async ({ context }) => {
      await context.addCookies([{ name: "lume_theme", value: theme, url: "http://127.0.0.1:3100" }]);
    });
    for (const [name, path] of [
      ["design", "/design"],
      ["sign-in", "/sign-in"],
      ["today", "/today"],
    ] as const) {
      test(name, async ({ page }) => {
        await page.goto(path);
        await settle(page);
        await expect(page).toHaveScreenshot(`${name}-${theme}.png`, { fullPage: true });
      });
    }
  });
}
