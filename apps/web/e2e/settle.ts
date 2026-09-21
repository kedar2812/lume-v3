import type { Page } from "@playwright/test";

/** Wait for the page to be visually settled: fonts loaded, no running animations, a short idle. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, {
    timeout: 8000,
  });
  await page.waitForTimeout(600);
}
