import {
  agreeToTerms,
  alertIn,
  enterCode,
  expect,
  PEOPLE,
  readSetupToken,
  stateFile,
  test,
} from "./fixtures";

test("@smoke first run: the wizard creates the business and the owner, with two-step sign-in", async ({
  page,
}) => {
  // On a brand-new installation every door leads to the setup wizard.
  await page.goto("/today");
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel("Setup token").fill("not-the-token");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(alertIn(page)).toContainText(/isn’t valid/);

  await page.getByLabel("Setup token").fill(await readSetupToken());
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Business name").fill("Nupuur Coaching");
  await page.getByLabel("Timezone").fill("Dubai");
  await page.getByRole("option", { name: /Dubai/ }).first().click();
  await expect(page.getByLabel("Timezone")).toHaveValue(/Dubai/);
  await page.getByRole("radio", { name: /Coaching/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Your name").fill(PEOPLE.owner.name);
  await page.getByLabel("Email").fill(PEOPLE.owner.email);
  await page.getByLabel("Password").fill(PEOPLE.owner.password);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  await enterCode(page);
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page.getByTestId("recovery-codes").getByRole("listitem")).toHaveCount(10);
  await expect(page.getByRole("button", { name: /open lume/i })).toBeDisabled();
  await page.getByRole("checkbox", { name: /saved/i }).check();
  await page.getByRole("button", { name: /open lume/i }).click();

  // Signed in: the licence agreement, terms and privacy policy first, then straight into onboarding.
  await agreeToTerms(page);
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole("dialog", { name: /welcome to lume/i })).toBeVisible();
  await page.context().storageState({ path: stateFile("owner") });

  // And the wizard can never be used a second time (signed in, it passes straight through to the app).
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/welcome$/);
});
