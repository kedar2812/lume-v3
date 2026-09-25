import { expect, hydrated, PEOPLE, stateFile, test } from "./fixtures";

const READER = "Licence agreement, terms of service and privacy policy";

test.describe("the first-use agreement", () => {
  test.use({ storageState: stateFile("fresh") });

  test("@smoke comes before everything, and I agree waits for the end of the text", async ({ page }) => {
    for (const path of ["/today", "/leads", "/welcome"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/agree$/);
    }
    await expect(page.getByRole("heading", { level: 1, name: "Before you start" })).toBeVisible();
    const agree = page.getByRole("button", { name: "I agree" });
    await expect(agree).toBeDisabled();
    await expect(page.getByText("Scroll to the end to agree")).toBeVisible();
    // Read with the keyboard alone: the reader takes focus and End goes to the end.
    await page.getByRole("region", { name: READER }).focus();
    await page.keyboard.press("End");
    await expect(agree).toBeEnabled();
    await expect(page.getByText("You’ve read to the end")).toBeVisible();
  });

  test("declining signs out, and signing in again comes back here", async ({ browser }) => {
    // Its own, empty session (not the saved one), so Zara's saved session stays signed in.
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const p = await ctx.newPage();
    await p.goto("/sign-in");
    await hydrated(p);
    await p.getByLabel("Email").fill(PEOPLE.fresh.email);
    await p.getByLabel("Password").fill(PEOPLE.fresh.password);
    await p.getByRole("button", { name: "Sign in" }).click();
    await expect(p).toHaveURL(/\/agree$/);
    await hydrated(p);
    await p.getByRole("button", { name: "Decline and sign out" }).click();
    await expect(p).toHaveURL(/\/sign-in$/);
    await p.goto("/today");
    await expect(p).toHaveURL(/\/sign-in/);
    await ctx.close();
  });
});
