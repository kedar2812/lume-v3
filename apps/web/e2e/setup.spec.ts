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

  // In a short window the card still fits: the step scrolls inside it, never the page.
  await expect(page.getByLabel("Business name")).toBeVisible();
  await expect(page.getByLabel("Setup token")).toHaveCount(0); // the previous step has gone
  await page.setViewportSize({ width: 1366, height: 560 });
  const fits = await page.evaluate(() => {
    const card = document.querySelector("form")!.closest("[class*='card']")!;
    const frame = document.querySelector("form")!.parentElement!;
    return {
      pageScrolls: document.scrollingElement!.scrollHeight > window.innerHeight,
      cardBottom: card.getBoundingClientRect().bottom,
      frameScrolls: frame.scrollHeight > frame.clientHeight,
    };
  });
  expect(fits.pageScrolls).toBe(false);
  expect(fits.cardBottom).toBeLessThanOrEqual(560);
  expect(fits.frameScrolls).toBe(true);
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.getByLabel("Business name").fill("Brightpath Studio");
  await page.getByLabel("Timezone").fill("Dubai");
  await page.getByRole("option", { name: /Dubai/ }).first().click();
  await expect(page.getByLabel("Timezone")).toHaveValue(/Dubai/);
  // The browser's guess (en-US → US Dollar) is only a starting point: this business trades in dirhams.
  await expect(page.getByRole("button", { name: /^Currency: US Dollar, USD/ })).toBeVisible();
  await page.getByRole("button", { name: /^Currency:/ }).click();
  await page.getByRole("combobox", { name: "Search currencies" }).fill("AED");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^Currency: .*, AED$/ })).toBeVisible();
  await page.getByRole("button", { name: /^Most leads are in:/ }).click();
  await page.getByRole("combobox", { name: "Search countries" }).fill("United Arab Emirates");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Most leads are in: United Arab Emirates" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /General sales/ })).toBeChecked();
  await page.getByRole("radio", { name: /Coaching/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Your name").fill(PEOPLE.owner.name);
  await page.getByLabel("Email").fill(PEOPLE.owner.email);
  await page.getByLabel("Password", { exact: true }).fill(PEOPLE.owner.password);
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
