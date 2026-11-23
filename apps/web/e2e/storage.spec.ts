import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { callApi, expect, openApp, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * Settings › Storage end to end (plan 2026-11-23-storage-clean-up, Task 5): an archived library file found, cleared
 * through the sheet and the morph, the page's numbers read again; and at every width, in both themes, nothing runs off
 * the side (owner 2026-11-23: "dont overflow the contents").
 */
test.use({ storageState: stateFile("owner") });

/** A library file, uploaded and archived, so Clean up has something real to give back. */
async function archivedFile(page: Page, name: string): Promise<void> {
  const id = await page.evaluate(
    async ({ name }) => {
      const { token } = await (await fetch("/api/v1/auth/csrf")).json();
      const r = await fetch("/api/v1/files", {
        method: "POST",
        headers: {
          "x-csrf-token": token,
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(name),
        },
        body: new Blob([`${name} ${Math.random()}`.repeat(400)], { type: "text/plain" }),
      });
      return (await r.json()).file.id as string;
    },
    { name },
  );
  const a = await callApi(page, "POST", `/api/v1/files/${id}/archive`);
  expect(a.status, JSON.stringify(a.data)).toBeLessThan(300);
}

/** Nothing wider than the window, and no row's words pushing past its box. */
async function noOverflow(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(wide).toBeLessThanOrEqual(0);
  const spill = await page.evaluate(() =>
    [...document.querySelectorAll("[data-storage] *, [role=dialog] *")]
      .filter((el) => {
        const s = getComputedStyle(el);
        if (s.overflowX === "auto" || s.overflowX === "scroll") return false;
        return (
          el.scrollWidth > el.clientWidth + 1 && s.overflowX !== "hidden" && s.textOverflow !== "ellipsis"
        );
      })
      .map((el) => `${el.tagName}.${el.className}`)
      .slice(0, 5),
  );
  expect(spill).toEqual([]);
}

test.describe("Settings › Storage", () => {
  test("an archived file found, cleared through the sheet and the morph; the numbers read again", async ({
    page,
  }) => {
    await openApp(page, "/media");
    await archivedFile(page, "Old price list.txt");
    await openApp(page, "/settings/storage");
    await expect(page.getByRole("heading", { name: "Storage" })).toBeVisible();
    await page.getByRole("button", { name: "Clean up" }).click();
    const sheet = page.getByRole("dialog", { name: "Clean up" });
    const library = sheet.getByRole("checkbox", { name: /Archived library files/ });
    await expect(library).toBeVisible();
    // Only the archived file: the defaults off, this one on.
    for (const box of await sheet.getByRole("checkbox", { checked: true }).all()) await box.uncheck();
    await library.check();
    const clear = sheet.getByRole("button", { name: /^Clear / });
    await expect(clear).toBeEnabled();
    await clear.click();
    await expect(page.getByRole("status").filter({ hasText: "back on this server" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("button", { name: /back$/ })).toBeVisible({ timeout: 10_000 });
    // Cleared for good: the next look has nothing archived to give back.
    await expect
      .poll(async () => {
        const s = await callApi<{ candidates: { kind: string; files: number }[] }>(
          page,
          "GET",
          "/api/v1/storage",
        );
        return s.data.candidates.find((c) => c.kind === "library")?.files;
      })
      .toBe(0);
  });

  for (const theme of ["light", "dark"] as const)
    test(`nothing runs off the side at any width (${theme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [375, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await openApp(page, "/settings/storage");
        await settle(page);
        await noOverflow(page);
        await page.getByRole("button", { name: "Clean up" }).click();
        await expect(page.getByRole("dialog", { name: "Clean up" })).toBeVisible();
        await noOverflow(page);
        await page.keyboard.press("Escape");
      }
    });

  test("accessible as drawn", async ({ page }) => {
    await openApp(page, "/settings/storage");
    await settle(page);
    const r = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
