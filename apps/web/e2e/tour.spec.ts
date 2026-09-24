import { expect, hydrated, PEOPLE, stateFile, test } from "./fixtures";

test.describe("the tour, as a sales rep", () => {
  test.use({ storageState: stateFile("rep") });

  test("@smoke highlights one thing at a time, is skippable for good, and can be replayed", async ({
    page,
  }) => {
    await page.goto("/today?tour=1");
    const card = page.getByRole("dialog", { name: /tour/i });
    await expect(card).toContainText("This is LUME");
    await expect(page.getByTestId("tour-veil")).toBeVisible();
    // The hole sits over the highlighted element, and the card beside it is fully on screen.
    const brand = await page.getByTestId("lockup").boundingBox();
    const box = await card.boundingBox();
    expect(box!.x).toBeGreaterThan(brand!.x + brand!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(800);

    await page.keyboard.press("ArrowRight");
    await expect(card).toContainText("Start on Today");
    await expect(card.locator("strong")).toHaveText("Today"); // module names read as names

    const saved = page.waitForResponse((r) => r.url().endsWith("/api/v1/me/tour") && r.ok());
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await saved; // the skip is on the server before the reload asks for it
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("dialog", { name: /tour/i })).toHaveCount(0); // never nags again

    await page.goto("/settings");
    await page.getByRole("button", { name: /replay the tour/i }).click();
    await expect(page.getByRole("dialog", { name: /tour/i })).toContainText("This is LUME");
  });

  test("a rep is never shown admin-only steps, and the tour ends with Done", async ({ page }) => {
    await page.goto("/today?tour=1");
    const card = page.getByRole("dialog", { name: /tour/i });
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      seen.push(await card.getByRole("heading").innerText());
      const done = page.getByRole("button", { name: "Done" });
      if (await done.isVisible()) {
        await done.click();
        break;
      }
      await page.getByRole("button", { name: "Next" }).click();
    }
    expect(seen[0]).toBe("This is LUME");
    expect(seen.at(-1)).toBe("That’s LUME");
    expect(seen.join(" | ")).not.toMatch(/People and roles|Audit log/);
    await expect(card).toHaveCount(0);
  });

  test("the profile menu replays the tour and signs out", async ({ browser }) => {
    // A session of its own: signing out ends only this one, not the one the other specs reuse.
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await page.goto("/sign-in");
    await hydrated(page);
    await page.getByLabel("Email").fill(PEOPLE.rep.email);
    await page.getByLabel("Password").fill(PEOPLE.rep.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/today$/);
    await page.getByRole("button", { name: /Riya/ }).click();
    await page.getByRole("menuitem", { name: "Replay the tour" }).click();
    await expect(page.getByRole("dialog", { name: /tour/i })).toContainText("This is LUME");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Riya/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto("/today");
    await expect(page).toHaveURL(/\/sign-in/); // the session is really gone, not just the page
    await ctx.close();
  });
});

test.describe("the tour, as the owner", () => {
  test("shows the admin steps", async ({ page }) => {
    await page.goto("/today?tour=1");
    const card = page.getByRole("dialog", { name: /tour/i });
    const seen: string[] = [];
    for (let i = 0; i < 30 && !(await page.getByRole("button", { name: "Done" }).isVisible()); i++) {
      seen.push(await card.getByRole("heading").innerText());
      await page.getByRole("button", { name: "Next" }).click();
    }
    expect(seen).toEqual(expect.arrayContaining(["People and roles", "Audit log"]));
  });
});
