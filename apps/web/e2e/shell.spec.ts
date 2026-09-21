import { expect, test } from "@playwright/test";

test("root redirects to Today and the shell shows the lockup", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/today$/);
  const lockup = page.getByTestId("lockup");
  await expect(lockup).toContainText("LUME");
  await expect(lockup).toContainText("Nupuur Coaching");
});

test("sidebar navigation updates the URL, title and current item", async ({ page }) => {
  await page.goto("/today");
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Analytics");
  await expect(page.getByRole("link", { name: "Analytics" })).toHaveAttribute("aria-current", "page");
});

test("theme choice survives a reload (server-rendered, no flash)", async ({ page }) => {
  await page.goto("/today");
  await page.getByRole("radio", { name: "Obsidian" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "obsidian");
});

test("Ctrl+K opens the palette and Enter navigates", async ({ page }) => {
  await page.goto("/today");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("lead");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/leads$/);
});

test("every response carries a nonce CSP", async ({ page }) => {
  const res = await page.goto("/sign-in");
  expect(res?.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-/);
});
