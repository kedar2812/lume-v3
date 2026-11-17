import { callApi, alertIn, enterCode, expect, openApp, stateFile, test } from "./fixtures";

type Me = {
  user: { name: string; theme: string };
  preferences: { workingDays: number[]; alerts: { emailDigest: boolean } };
  onboarding: { completedAt: string | null };
  twoFactor: { enabled: boolean };
};

test.describe("a sales rep", () => {
  test.use({ storageState: stateFile("rep") });

  test("@smoke onboarding saves their choices and hands over to the tour", async ({ page, browser }) => {
    // Connect and the morning email are offered only where the business has them (bug hunt 2026-11-17). This server
    // has no Connect with Google, so Calendar can't be on and there's no Connect step (ConnectCards' tests cover its
    // button); the owner switches the morning email on for this, and back after.
    const owner = await browser.newContext({ storageState: stateFile("owner") });
    const op = await owner.newPage();
    await openApp(op, "/today");
    expect((await callApi(op, "PUT", "/api/v1/integrations/google-calendar", { enabled: true })).status).toBe(
      409,
    );
    expect(
      (await callApi(op, "PUT", "/api/v1/settings/follow-ups", { digest: { enabled: true } })).status,
    ).toBe(200);
    try {
      // Until onboarding is done, the app itself sends them back to it.
      await page.goto("/leads");
      await expect(page).toHaveURL(/\/welcome$/);
      await expect(page.getByRole("dialog", { name: /welcome to lume, riya/i })).toBeVisible();
      await expect(page.getByRole("navigation", { name: /steps/i }).getByRole("button")).toHaveText([
        "Welcome",
        "You",
        "Look",
        "Your day",
        "Alerts",
        "All set",
      ]);
      await page.getByRole("button", { name: /let’s go/i }).click();

      await page.getByLabel("Your name").fill("Riya S");
      await page.getByRole("button", { name: "Continue" }).click();

      await page.getByRole("radio", { name: /obsidian/i }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "obsidian");
      await page.getByRole("button", { name: "Continue" }).click();

      await page.getByRole("button", { name: "Sat" }).click();
      await expect(page.getByTestId("day-preview")).toContainText("Mon, Tue, Wed, Thu, Fri, Sat");
      await page.getByRole("button", { name: "Continue" }).click();

      await page.getByRole("switch", { name: /email me the morning digest/i }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("heading", { name: "You’re all set, Riya" })).toBeVisible();
      await page.getByRole("button", { name: /take the tour/i }).click();

      await expect(page).toHaveURL(/\/today$/); // ?tour=1 is tidied away
      await expect(page.getByRole("dialog", { name: /tour/i })).toContainText("This is LUME");

      // Everything stuck on the server: the name, the theme, the day, and onboarding itself.
      const { data: me } = await callApi<Me>(page, "GET", "/api/v1/auth/me");
      expect(me.user).toMatchObject({ name: "Riya S", theme: "obsidian" });
      expect(me.preferences.workingDays).toEqual([1, 2, 3, 4, 5, 6]);
      expect(me.preferences.alerts.emailDigest).toBe(false);
      expect(me.onboarding.completedAt).not.toBeNull();
      await page.goto("/welcome");
      await expect(page).toHaveURL(/\/today$/);
      await expect(page.getByTestId("lockup")).toContainText("Brightpath Studio");
    } finally {
      await callApi(op, "PUT", "/api/v1/settings/follow-ups", { digest: { enabled: false } });
      await owner.close();
    }
  });
});

test.describe("an admin", () => {
  test.use({ storageState: stateFile("admin") });

  test("must set up two-step sign-in before the rest, and it really works", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByRole("button", { name: /let’s go/i }).click();
    await page.getByRole("button", { name: "Continue" }).click(); // past You
    await expect(page.getByRole("heading", { name: "Secure your account" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0);
    const rail = page.getByRole("navigation", { name: /steps/i });
    await expect(rail.getByRole("button", { name: "Alerts" })).toBeDisabled();

    // A wrong code is explained and the boxes clear for another go.
    await page.getByLabel("Digit 1 of 6").click();
    await page.keyboard.type("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(alertIn(page)).toContainText(/didn’t work/);
    await expect(page.getByLabel("Digit 1 of 6")).toHaveValue("");

    await enterCode(page);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByTestId("recovery-codes").getByRole("listitem")).toHaveCount(10);
    // The codes alone, centred: a list bullet stayed at the cell's far edge, adrift from its code (2026-10-19).
    const markers = await page
      .getByTestId("recovery-codes")
      .getByRole("listitem")
      .evaluateAll((items) => items.map((li) => getComputedStyle(li).listStyleType));
    expect(new Set(markers)).toEqual(new Set(["none"]));
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
    await page.getByRole("checkbox", { name: /saved/i }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "How should LUME look?" })).toBeVisible();

    // Enrolment rotated the session; the new one is what the rest of the run must use.
    await page.context().storageState({ path: stateFile("admin") });
    const { data: me } = await callApi<Me>(page, "GET", "/api/v1/auth/me");
    expect(me.twoFactor.enabled).toBe(true);
  });
});
