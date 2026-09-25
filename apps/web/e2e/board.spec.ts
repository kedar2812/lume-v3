import { expect, openApp, test } from "./fixtures";

test("@smoke drag a card to the next stage; the count moves and it sticks", async ({ page }) => {
  await openApp(page, "/pipeline");
  const from = page.getByRole("region", { name: /^New,/ });
  const to = page.getByRole("region", { name: /^Message sent,/ });
  const before = { from: await from.getAttribute("aria-label"), to: await to.getAttribute("aria-label") };
  const card = from
    .locator("[data-lead-card]")
    .filter({ hasText: "Sara Nasser" })
    .or(from.locator("[data-lead-card]").first());
  const name = (await card.first().innerText()).split("\n")[0]!;
  const a = (await card.first().boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 120, { steps: 12 });
  await page.mouse.up();
  await expect(to.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  expect(await from.getAttribute("aria-label")).not.toBe(before.from);
  await page.reload();
  await expect(
    page.getByRole("region", { name: /^Message sent,/ }).getByRole("button", { name: new RegExp(name) }),
  ).toBeVisible();
});

test("move a card with the keyboard only; dropping on Lost asks why, and cancelling puts it back", async ({
  page,
}) => {
  await openApp(page, "/pipeline");
  const card = page
    .getByRole("region", { name: /^Message sent,/ })
    .locator("[data-lead-card]")
    .first();
  const name = (await card.innerText()).split("\n")[0]!;
  await card.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("status").filter({ hasText: /picked up/i })).toBeVisible();
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight"); // clamps at the last column: Lost
  await page.keyboard.press("Enter");
  await page
    .getByRole("dialog", { name: /why was .* lost/i })
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(
    page.getByRole("region", { name: /^Message sent,/ }).getByRole("button", { name: new RegExp(name) }),
  ).toBeVisible();
});
