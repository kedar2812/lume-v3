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

test("a short window scrolls the sidebar; nothing in it is squashed to fit", async ({ page }) => {
  // On a laptop window the Views rows were squeezed until they overlapped (owner, 2026-10-31): the sidebar must
  // scroll instead, with the lockup and the profile kept in place, and show no scrollbar when everything fits.
  const rows = (where: string) =>
    page.locator(where).evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.textContent?.trim() ?? "", top: r.top, bottom: r.bottom, height: r.height };
      }),
    );
  for (const height of [560, 640]) {
    await page.setViewportSize({ width: 1366, height });
    await openApp(page, "/today");
    const views = page.getByRole("list", { name: "Views" });
    await expect(views.getByRole("link").first()).toBeVisible();
    for (const [where, tall] of [
      ['nav[aria-label="Main"] > a', 34],
      ['[aria-label="Views"] > li', 30],
    ] as const) {
      const list = await rows(where);
      expect(list.length, where).toBeGreaterThan(0);
      for (const r of list) expect(r.height, `${height}px: ${r.name}`).toBeGreaterThanOrEqual(tall - 0.5);
      for (let i = 1; i < list.length; i++)
        expect(list[i]!.top, `${height}px: ${list[i]!.name} overlaps`).toBeGreaterThanOrEqual(
          list[i - 1]!.bottom - 0.5,
        );
    }
    const scroll = page.getByTestId("side-scroll");
    const box = await scroll.evaluate((el) => ({ scrolls: el.scrollHeight > el.clientHeight + 1 }));
    expect(box.scrolls, `${height}px: the sidebar scrolls`).toBe(true);
    // The profile stays whole on screen, and the last view can be scrolled to.
    const me = await page.getByTestId("lockup").evaluate(() => {
      const el = document.querySelector("aside button[aria-haspopup]") as HTMLElement | null;
      const r = el?.getBoundingClientRect();
      return r ? { top: r.top, bottom: r.bottom } : null;
    });
    expect(me, "the profile button").not.toBeNull();
    expect(me!.bottom).toBeLessThanOrEqual(height);
    const last = views.getByRole("link").last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openApp(page, "/today");
  const fits = await page.getByTestId("side-scroll").evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
  expect(fits, "a tall window shows no scrollbar").toBe(true);
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
