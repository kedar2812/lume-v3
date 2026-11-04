import type { Page } from "@playwright/test";
import { PEOPLE, callApi, expect, openApp, stateFile, test } from "./fixtures";
import { whatsNewDue, whatsappSwitch } from "./db";
import { WIDTHS, cutText, spills } from "./spills";

/**
 * What's new in LUME (spec 2026-11-02), in the real app: once per version, Show me lands on the feature with its ring,
 * and the window fits every size LUME supports with no text cut and nothing spilling or off the window.
 */
test.use({ storageState: stateFile("owner") });

const win = (page: Page) => page.getByRole("dialog", { name: "What's new in 1.2.0" });
let whatsappWas = false;

/** LUME AI and WhatsApp on (the three stories need them), What's new due for the owner, then Today. */
async function due(page: Page) {
  await openApp(page, "/settings/about");
  const ai = await callApi(page, "PUT", "/api/v1/integrations/ai", { enabled: true });
  expect(ai.status, JSON.stringify(ai.data)).toBe(200);
  whatsappWas = await whatsappSwitch(true);
  await whatsNewDue(PEOPLE.owner.email);
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ storageState: stateFile("owner") });
  await openApp(page, "/settings/about");
  await callApi(page, "PUT", "/api/v1/integrations/ai", { enabled: false });
  await whatsappSwitch(whatsappWas);
  await page.close();
});

test.describe("What's new in LUME", () => {
  test("opens once, plays its stories, and Show me lands on LUME AI's calls with the ring", async ({
    page,
  }) => {
    await due(page);
    await openApp(page, "/today");
    await expect(win(page)).toBeVisible();
    // The opening rolls 1.1.0 to 1.2.0, then the first story.
    await expect(win(page).getByText("1 of 3")).toBeVisible({ timeout: 8000 });
    await expect(win(page).getByRole("navigation", { name: "This update" }).getByRole("button")).toHaveCount(
      3,
    );
    await win(page).getByRole("button", { name: "Show me" }).click();
    await expect(page).toHaveURL(/\/settings\/ai$/);
    const tip = page.getByRole("dialog", { name: "Calls LUME AI may book" });
    await expect(tip).toBeVisible({ timeout: 8000 });
    // The spotlight's hole sits on the calls panel, and the tip is beside it, not over it.
    const panel = await page.locator('[data-whatsnew="calls"]').boundingBox();
    const at = await tip.boundingBox();
    expect(panel && at).toBeTruthy();
    const overlap =
      Math.min(panel!.y + panel!.height, at!.y + at!.height) - Math.max(panel!.y, at!.y) > 0 &&
      Math.min(panel!.x + panel!.width, at!.x + at!.width) - Math.max(panel!.x, at!.x) > 0;
    expect(overlap).toBe(false);
    await expect(page.getByTestId("tour-veil")).toHaveAttribute("style", /clip-path: path/);
    await tip.getByRole("button", { name: "Got it" }).click();
    await expect(tip).toHaveCount(0);
    // Seen: a reload doesn't bring it back; Today keeps the way back.
    await openApp(page, "/today");
    await expect(
      page.getByRole("button", { name: "What's new in version 1.2.0", exact: true }),
    ).toBeVisible();
    await expect(win(page)).toHaveCount(0);
  });

  for (const size of WIDTHS)
    test(`fits at ${size.width}×${size.height}: no text cut, nothing spills, nothing off the window`, async ({
      page,
    }) => {
      // The finished frames: what's checked is where everything rests.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize(size);
      await due(page);
      await openApp(page, "/today");
      await expect(win(page)).toBeVisible();
      const problems: string[] = [];
      for (let i = 0; i < 3; i++) {
        await expect(win(page).getByText(`${i + 1} of 3`)).toBeVisible();
        for (const p of await spills(page)) problems.push(`story ${i + 1}: ${p}`);
        for (const p of await cutText(page, '[aria-labelledby="whats-new-title"]'))
          problems.push(`story ${i + 1}: ${p}`);
        const box = await win(page).boundingBox();
        if (
          !box ||
          box.x < 0 ||
          box.y < 0 ||
          box.x + box.width > size.width + 1 ||
          box.y + box.height > size.height + 1
        )
          problems.push(`story ${i + 1}: the window runs off the screen (${JSON.stringify(box)})`);
        await win(page).press("ArrowRight");
      }
      expect(problems).toEqual([]);
    });
});

/** Each story's finished frame, and Show me's tip, as approved: three sizes, both themes. */
for (const theme of ["porcelain", "obsidian"] as const)
  test.describe(`What's new looks as approved (${theme})`, () => {
    for (const size of [
      { width: 1366, height: 800 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
    ])
      test(`each story at ${size.width}×${size.height}`, async ({ page, context }) => {
        await context.addCookies([{ name: "lume_theme", value: theme, url: "http://127.0.0.1:3100" }]);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize(size);
        await due(page);
        await openApp(page, "/today");
        for (let i = 0; i < 3; i++) {
          await expect(win(page).getByText(`${i + 1} of 3`)).toBeVisible();
          await expect(win(page)).toHaveScreenshot(`whats-new-${i + 1}-${size.width}-${theme}.png`);
          await win(page).press("ArrowRight");
        }
      });

    test("Show me's tip on Settings → LUME AI", async ({ page, context }) => {
      await context.addCookies([{ name: "lume_theme", value: theme, url: "http://127.0.0.1:3100" }]);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 1366, height: 800 });
      await due(page);
      await openApp(page, "/today");
      await win(page).getByRole("button", { name: "Show me" }).click();
      const tip = page.getByRole("dialog", { name: "Calls LUME AI may book" });
      await expect(tip).toBeVisible({ timeout: 8000 });
      await expect(tip).toHaveScreenshot(`whats-new-tip-${theme}.png`);
    });
  });
