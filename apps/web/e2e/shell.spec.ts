import { expect, openApp, test } from "./fixtures";

test("root redirects to Today and the shell shows the lockup", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/today$/);
  const lockup = page.getByTestId("lockup");
  await expect(lockup).toContainText("LUME");
  await expect(lockup).toContainText("Brightpath Studio");
});

test("sidebar navigation updates the URL, title and current item", async ({ page }) => {
  await openApp(page, "/today");
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Analytics");
  await expect(page.getByRole("link", { name: "Analytics" })).toHaveAttribute("aria-current", "page");
});

test("theme choice survives a reload (server-rendered, no flash)", async ({ page }) => {
  await openApp(page, "/today");
  await page.getByRole("radio", { name: "Obsidian" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "obsidian");
});

test("Ctrl+K opens the palette and Enter navigates", async ({ page }) => {
  await openApp(page, "/today");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("lead");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/leads$/);
});

test("Today's tiles show every footer line in full, never cut off mid-word", async ({ page }) => {
  // The Team tile read "The on-time rate shows after 10 are c" on a client's demo (2026-10-19): a one-line
  // footer clipped its text with no ellipsis.
  await openApp(page, "/today");
  // A hook of its own: a CSS module's class names change with Next (16.4 made "__foot" "_foot").
  const feet = page.locator("[data-tile-foot]");
  await expect(feet.first()).toBeVisible();
  const cut = await feet.evaluateAll((els) =>
    els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent?.trim()),
  );
  expect(cut).toEqual([]);
});

test("every response carries a nonce CSP", async ({ page }) => {
  const res = await page.goto("/sign-in");
  expect(res?.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-/);
});
