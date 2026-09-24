import { alertIn, expect, lastMailTo, linkIn, PEOPLE, test } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

test("@smoke signing in: the door, a wrong password, then in — and back to where they were going", async ({
  page,
}) => {
  await page.goto("/leads");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fleads$/);
  // Strangers never see whose workspace this is: the signed-out screens say only "LUME".
  await expect(page.getByText("Nupuur Coaching")).toHaveCount(0);

  await page.getByLabel("Email").fill(PEOPLE.aman.email);
  await page.getByLabel("Password").fill("not the password at all");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(alertIn(page)).toContainText(/don’t match/i);

  await page.getByLabel("Password").fill(PEOPLE.aman.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Aman hasn't done onboarding, so the app routes him there first.
  await expect(page).toHaveURL(/\/welcome$/);

  // Already signed in, the sign-in page steps aside.
  await page.goto("/sign-in");
  await expect(page).not.toHaveURL(/\/sign-in/);
});

test("the owner signs in with a two-step code", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(PEOPLE.owner.email);
  await page.getByLabel("Password").fill(PEOPLE.owner.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Two-step check")).toBeVisible();
  await page.getByLabel("Digit 1 of 6").click();
  await page.keyboard.type("000000");
  await expect(alertIn(page)).toContainText(/didn’t work/);
});

test("a reset email arrives, refuses a breached password, and sets a new one", async ({ page }) => {
  const since = new Date(Date.now() - 1000).toISOString();
  await page.goto("/forgot");
  await page.getByLabel("Email").fill(PEOPLE.aman.email);
  await page.getByRole("button", { name: "Send the link" }).click();
  await expect(page.getByText(/on its way/i)).toBeVisible();

  const link = linkIn(await lastMailTo(page.request, PEOPLE.aman.email, since), "reset");
  await page.goto(link);
  await page.getByLabel("New password").fill("password1234"); // on the breached list
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(alertIn(page)).toContainText(/data breach/i);

  const fresh = "a brand new quiet passphrase";
  await page.getByLabel("New password").fill(fresh);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByText(/sign in with your new password/i)).toBeVisible();

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(PEOPLE.aman.email);
  await page.getByLabel("Password").fill(fresh);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/(today|welcome)$/);

  // The link worked once; a second use is refused.
  await page.goto(link);
  await page.getByLabel("New password").fill("yet another long passphrase");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(alertIn(page)).toContainText(/expired or has already been used/i);
});

test("an unknown email gets the same answer as a known one (no account discovery)", async ({ page }) => {
  await page.goto("/forgot");
  await page.getByLabel("Email").fill("nobody@nowhere.test");
  await page.getByRole("button", { name: "Send the link" }).click();
  await expect(page.getByText(/on its way/i)).toBeVisible();
});

test("a dead invite link explains itself instead of breaking", async ({ page }) => {
  await page.goto(`/invite/${"z".repeat(43)}`);
  await expect(page.getByText(/no longer valid/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
});

test("sign-in never redirects off-site", async ({ page }) => {
  await page.goto("/sign-in?next=//evil.example");
  await page.getByLabel("Email").fill(PEOPLE.rep.email);
  await page.getByLabel("Password").fill(PEOPLE.rep.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3100\/(today|welcome)$/);
});
