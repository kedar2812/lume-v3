import { callApi, expect, openApp, stateFile, test } from "./fixtures";
import { appendRows, connectViaApi, putSheet, sheetLink } from "./sheets-helpers";

const row = (i: number, name: string) => [
  `2026-09-27 0${i}:00:00`,
  name,
  `050300${String(i).padStart(4, "0")}`,
  "",
];

test.describe("Google Sheets", () => {
  // Leave the workspace as it was: later specs (visual.spec's approved screenshots) must not see these
  // sheets' leads, and Sheets goes back to off.
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await page.goto("/leads");
    const { sources } = (await callApi<{ sources: { id: string }[] }>(page, "GET", "/api/v1/sheets/sources"))
      .data ?? {
      sources: [],
    };
    for (const s of sources) {
      for (;;) {
        const { items } = (
          await callApi<{ items: { id: string }[] }>(page, "GET", `/api/v1/leads?source=${s.id}&limit=100`)
        ).data;
        if (!items.length) break;
        await callApi(page, "POST", "/api/v1/leads/bulk", {
          ids: items.map((l) => l.id),
          action: { type: "delete" },
        });
      }
      await callApi(page, "DELETE", `/api/v1/sheets/sources/${s.id}`);
    }
    await callApi(page, "PUT", "/api/v1/integrations/google-sheets", { enabled: false });
    await ctx.close();
  });

  test("Settings → Integrations: switch on, add a sheet through the steps, and its leads arrive", async ({
    page,
  }) => {
    const id = await putSheet([row(1, "Wizard Lead One"), row(2, "Wizard Lead Two")]);
    await openApp(page, "/settings/integrations");
    const sw = page.getByRole("switch", { name: "Google Sheets" });
    if ((await sw.getAttribute("aria-checked")) === "false") await sw.click();
    await page.getByRole("button", { name: "Add a sheet" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a sheet" });
    await dialog.getByLabel("Sheet link").fill(sheetLink(id));
    await dialog.getByRole("button", { name: "Check" }).click();
    await expect(dialog.getByLabel("Tab")).toHaveValue("0");
    await dialog.getByRole("button", { name: "Continue" }).click(); // Sheet
    await dialog.getByRole("button", { name: "Continue" }).click(); // Columns
    await dialog.getByRole("button", { name: "Continue" }).click(); // Rules
    await dialog.getByRole("button", { name: "Continue" }).click(); // Preview
    await dialog.getByRole("button", { name: "Connect sheet" }).click();
    await expect(dialog).toBeHidden();
    const link = page.getByRole("link", { name: /Website enquiries/ }).first();
    await expect(link).toContainText(/2 new today/, { timeout: 15_000 });
    await openApp(page, "/leads?q=Wizard%20Lead");
    await expect(page.getByRole("row", { name: /Wizard Lead One/ })).toBeVisible();
  });

  test("Refresh brings new rows in with the real count, and they glow", async ({ page }) => {
    const id = await putSheet([row(3, "Before Refresh")]);
    await openApp(page, "/leads");
    await connectViaApi(page, id);
    await appendRows(id, [row(4, "Refresh Arrival A"), row(5, "Refresh Arrival B")]);
    await openApp(page, "/leads");
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await refresh.click();
    await expect(page.getByRole("status").filter({ hasText: /new leads?/ })).toContainText(/\d+ new leads?/, {
      timeout: 20_000,
    });
    await expect(page.locator("tr[data-arrived]").filter({ hasText: "Refresh Arrival A" })).toBeVisible();
    await expect(refresh).toBeFocused();
  });

  test("a rep's Refresh counts only the leads they can see", async ({ page, browser }) => {
    const id = await putSheet([]);
    await openApp(page, "/leads");
    await connectViaApi(page, id);
    // The seeded sales rep who sees only their own leads: an unassigned lead isn't theirs.
    const ctx = await browser.newContext({ storageState: stateFile("seller") });
    const rep = await ctx.newPage();
    await appendRows(id, [row(6, "Nobody's Lead")]);
    await openApp(rep, "/leads");
    await rep.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(rep.getByRole("status").filter({ hasText: /Up to date|for you/ })).toContainText(
      "Up to date",
      { timeout: 20_000 },
    );
    await ctx.close();
  });

  test("Reduce Motion: a still card, the same words", async ({ page }) => {
    const id = await putSheet([row(7, "Still Card")]);
    await openApp(page, "/leads");
    await connectViaApi(page, id, "new");
    await appendRows(id, [row(8, "Still Card Two")]);
    await openApp(page, "/leads"); // the config's default is reducedMotion: "reduce"
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("Syncing new enquiries").first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /new lead/ })).toBeVisible({ timeout: 20_000 });
  });

  test("with Sheets switched off there is no Refresh anywhere", async ({ page }) => {
    await openApp(page, "/leads");
    await callApi(page, "PUT", "/api/v1/integrations/google-sheets", { enabled: false });
    await openApp(page, "/leads");
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
    await callApi(page, "PUT", "/api/v1/integrations/google-sheets", { enabled: true });
  });

  test("screenshots: the Integrations card, a sheet's page, and the Refresh result — both themes", async ({
    page,
  }) => {
    const id = await putSheet([row(9, "Shot One")]);
    await openApp(page, "/leads");
    const sourceId = await connectViaApi(page, id);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/settings/integrations");
      await expect(page.getByRole("link", { name: /Website enquiries/ }).first()).toBeVisible();
      await expect(page.locator("main")).toHaveScreenshot(`integrations-${theme}.png`, {
        // Every row's health line (its time and today's count), found by structure: which rows read "just now"
        // and how many are new today depend on the machine's speed, so masking by text left some unmasked.
        mask: [page.locator("a[href^='/settings/integrations/'] > span:nth-child(2)")],
      });
      await openApp(page, `/settings/integrations/${sourceId}`);
      await expect(page.getByRole("table", { name: "Recent syncs" })).toBeVisible();
      await expect(page.locator("main")).toHaveScreenshot(`sheet-page-${theme}.png`, {
        mask: [
          page.locator("td").first(),
          page.locator("dd").first(),
          page.locator("dd").nth(1),
          page.locator("[data-live-count]"),
        ],
      });
    }
  });
});
