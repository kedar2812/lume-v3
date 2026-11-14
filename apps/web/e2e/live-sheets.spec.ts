import { expect, openApp, stateFile, test } from "./fixtures";

/**
 * Live sheets (spec 2026-11-14) in the browser. This stack runs without Connect with Google (by design: it would change
 * the Integrations and Calendar screens), so the page says it isn't set up here and the buttons say so too. Making a
 * sheet in Google, end to end through the real relay, is the API's tests' work (apps/api/src/modules/live-sheets).
 */
test("Live sheets: in the sidebar after Pipeline, a page that says why it can't make one here", async ({
  page,
}) => {
  await openApp(page, "/today");
  const nav = page.getByRole("navigation", { name: /main|sidebar/i }).first();
  const links = await nav.getByRole("link").allInnerTexts();
  const at = links.findIndex((t) => t.trim() === "Live sheets");
  expect(at).toBeGreaterThan(links.findIndex((t) => t.trim() === "Pipeline"));
  await nav.getByRole("link", { name: "Live sheets" }).click();
  await expect(page).toHaveURL(/\/live-sheets$/);
  await expect(page.getByRole("heading", { name: "Live sheets", level: 1 })).toBeVisible();
  await expect(
    page.getByText("Connect with Google isn't set up on this LUME, so it can't make sheets yet."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a live sheet" })).toHaveCount(0);
});

test("Leads and Pipeline: Create a live sheet says the same, instead of a form that can't finish", async ({
  page,
}) => {
  for (const path of ["/leads", "/pipeline"]) {
    await openApp(page, path);
    await page.getByRole("button", { name: "Create a live sheet" }).click();
    const d = page.getByRole("dialog", { name: "Live sheets" });
    await expect(d).toContainText("Connect with Google isn't set up on this LUME");
    await d.getByRole("button", { name: "OK" }).click();
    await expect(d).toHaveCount(0);
  }
  // Each Pipeline column offers one of its own stage, named for screen readers.
  await expect(page.getByRole("button", { name: /^Make a live sheet of / }).first()).toBeAttached();
});

test("a rep who may not make live sheets sees no sign of them", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: stateFile("seller") });
  const p = await ctx.newPage();
  try {
    await openApp(p, "/leads");
    await expect(p.getByRole("button", { name: "Create a live sheet" })).toHaveCount(0);
    await expect(p.getByRole("link", { name: "Live sheets" })).toHaveCount(0);
    await p.goto("/live-sheets");
    await expect(p).toHaveURL(/\/today/);
  } finally {
    await ctx.close();
  }
});
