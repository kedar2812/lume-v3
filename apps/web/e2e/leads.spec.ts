import { callApi, expect, PEOPLE, stateFile, test } from "./fixtures";

test.describe("the owner works leads", () => {
  test("@smoke create a lead, see the duplicate warning, and land in it", async ({ page }) => {
    await page.goto("/leads");
    await page.getByRole("button", { name: "New lead" }).first().click();
    const sheet = page.getByRole("dialog", { name: "New lead" });
    await sheet.getByLabel("Name").fill("Aisha Duplicate");
    await sheet.getByLabel("Phone").fill("+971501234567"); // Aisha Khan's number
    await expect(sheet.getByRole("status")).toContainText(
      "Aisha Khan already has this phone · handled by Noor Ahmed",
    );
    await sheet.getByLabel("Phone").fill("+971509990001");
    await expect(sheet.getByRole("status")).toBeEmpty();
    await sheet.getByRole("button", { name: "Create lead" }).click();
    await expect(page.getByRole("dialog", { name: "Aisha Duplicate" })).toBeVisible();
    await expect(page).toHaveURL(/lead=/);
    await expect(page.getByRole("button", { name: "Open Aisha Duplicate" })).toBeVisible();
  });

  test("@smoke move through stages: required fields prompt, lost reason prompt", async ({ page }) => {
    await page.goto("/leads?q=Omar");
    await page.getByRole("button", { name: "Open Omar Haddad" }).click();
    const drawer = page.getByRole("dialog", { name: "Omar Haddad" });
    await drawer.getByRole("button", { name: /^Message sent/ }).click();
    await expect(drawer.getByRole("button", { name: /^Message sent/ })).toHaveAttribute(
      "aria-current",
      "step",
    );
    await drawer.getByRole("button", { name: /^Call booked/ }).click();
    const need = page.getByRole("dialog", { name: /before moving to call booked/i });
    await need.getByRole("checkbox", { name: "Confidence" }).check();
    await need.getByRole("button", { name: "Save and move" }).click();
    await expect(drawer.getByRole("button", { name: /^Call booked/ })).toHaveAttribute(
      "aria-current",
      "step",
    );
    await drawer.getByRole("button", { name: "Lost" }).click();
    const why = page.getByRole("dialog", { name: /why was omar lost/i });
    await why.getByText("Not interested").click(); // the chip is the target; its radio carries the state
    await expect(why.getByRole("radio", { name: "Not interested" })).toBeChecked();
    await why.getByRole("button", { name: "Mark as lost" }).click();
    await drawer.getByRole("tab", { name: "History" }).click();
    await expect(drawer.getByText("Marked as lost")).toBeVisible();
    await expect(drawer.getByText("Moved to Call booked")).toBeVisible();
  });

  test("@smoke reassign: the previous rep loses the lead at once", async ({ page, browser }) => {
    await page.goto("/leads?q=Priya");
    await page.getByRole("button", { name: "Open Priya Menon" }).click();
    const url = page.url();
    const drawer = page.getByRole("dialog", { name: "Priya Menon" });
    await drawer.getByRole("button", { name: /owner: noor ahmed/i }).click();
    await page.getByRole("menuitem", { name: PEOPLE.admin.name }).click();
    await expect(drawer.getByRole("button", { name: /owner: tasneem shaikh/i })).toBeVisible();

    const rep = await browser.newContext({ storageState: stateFile("seller") });
    const p = await rep.newPage();
    await p.goto("/leads");
    await p.locator("html[data-hydrated]").waitFor({ state: "attached" });
    await expect(p.getByRole("button", { name: "Open Priya Menon" })).toHaveCount(0);
    await p.goto(url.replace(/^.*?(\/leads)/, "$1"));
    await expect(p.getByText(/isn’t available to you/i)).toBeVisible();
    await rep.close();
  });

  test("@smoke bulk: move three, and hear what was skipped and why", async ({ page }) => {
    await page.goto("/leads?q=Unassigned");
    await page.getByRole("checkbox", { name: "Select all loaded" }).check();
    await page.getByRole("button", { name: "Move to stage" }).click();
    await page.getByRole("menuitem", { name: "Call booked" }).click(); // needs Struggles, which neither has
    await expect(page.getByText("None moved, 2 skipped: missing required fields")).toBeVisible();
    await page.getByRole("button", { name: "Move to stage" }).click();
    await page.getByRole("menuitem", { name: "Message sent" }).click();
    await expect(page.getByText("2 moved")).toBeVisible();
  });
});

test.describe("a masked sales rep", () => {
  test.use({ storageState: stateFile("seller") });

  test("@smoke sees no contact column, no export, name-only search, and can reveal only on request", async ({
    page,
  }) => {
    await page.goto("/leads");
    const headers = await page.getByRole("columnheader").allInnerTexts();
    expect(headers.join(" ")).not.toMatch(/Phone|Email|Instagram/);
    await expect(page.getByRole("button", { name: /export/i })).toHaveCount(0);
    await expect(page.getByRole("searchbox")).toHaveAttribute("placeholder", "Search by name");
    await expect(page.getByRole("button", { name: "New lead" })).toHaveCount(0); // Sales can't create
    await expect(page.getByRole("checkbox", { name: "Select all loaded" })).toHaveCount(0); // nor bulk edit

    // The API agrees: contacts arrive masked, and a phone search matches nothing (names only).
    const list = await callApi<{ items: { name: string; phone: { masked: boolean } }[] }>(
      page,
      "GET",
      "/api/v1/leads?q=Aisha",
    );
    expect(list.data.items[0]!.phone.masked).toBe(true);
    const byDigits = await callApi<{ items: unknown[] }>(page, "GET", "/api/v1/leads?q=501234567");
    expect(byDigits.data.items).toHaveLength(0);

    await page.getByRole("button", { name: "Open Aisha Khan" }).click();
    const drawer = page.getByRole("dialog", { name: "Aisha Khan" });
    await expect(drawer.getByText("+971 50 123 4567")).toHaveCount(0);
    await drawer.getByRole("button", { name: "Reveal contact" }).click();
    await expect(drawer.getByText("+971 50 123 4567")).toBeVisible();
    await expect(drawer.getByText(/recorded in the audit log/i)).toBeVisible();
  });

  test("the WhatsApp hand-off opens a tab and never shows the link", async ({ page, context }) => {
    await page.goto("/leads?q=Sara");
    await page.getByRole("button", { name: "Open Sara Nasser" }).click();
    const drawer = page.getByRole("dialog", { name: "Sara Nasser" });
    await drawer.getByRole("button", { name: "WhatsApp" }).click();
    // WhatsApp itself is never contacted from a test run: its pages answer with a stub.
    await context.route(/^https:\/\/(wa\.me|api\.whatsapp\.com)\//, (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp</title>" }),
    );
    const [tab] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("button", { name: "Open WhatsApp" }).click(),
    ]);
    await tab.waitForURL(/^https:\/\/wa\.me\/971503334455/);
    expect(await tab.evaluate(() => window.opener)).toBeNull(); // the new tab can't reach back into LUME
    await tab.close();
    await expect(page.locator("body")).not.toContainText("wa.me");
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await drawer.getByRole("button", { name: "Yes, sent" }).click();
    await drawer.getByRole("tab", { name: "History" }).click();
    await expect(drawer.getByText("WhatsApp sent")).toBeVisible();
  });
});
