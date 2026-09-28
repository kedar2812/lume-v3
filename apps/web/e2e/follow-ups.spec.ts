import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { callApi, expect, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
const made: string[] = [];
async function lead(page: Page, name: string): Promise<string> {
  const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", { name });
  made.push(r.data.lead.id);
  return r.data.lead.id;
}
/** Everything time-dependent on these screens is marked data-volatile (times, the date, the greeting). */
const volatile = (page: Page) => [page.locator("[data-volatile]")];

test.describe("Follow-ups", () => {
  // Leave the workspace as it was: removing the leads cancels their follow-ups too.
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await page.goto("/leads");
    if (made.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    await ctx.close();
  });

  test("set from the drawer, on Today, live when due, and done: all clear", async ({ page }) => {
    await openApp(page, "/leads"); // callApi runs in the page, so the app has to be open
    const id = await lead(page, "Follow Up Person");
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Follow Up Person" });
    await drawer.getByRole("button", { name: "Follow-up", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Follow up with Follow" });
    await sheet.getByText("In 1 hour", { exact: true }).click(); // the chip's label (its radio is visually hidden)
    await sheet.getByRole("button", { name: "Set follow-up" }).click();
    await expect(sheet).toBeHidden();
    const next = page.getByRole("region", { name: "Next follow-up" });
    await expect(next).toContainText("Follow up");

    await openApp(page, "/today");
    const soon = page.getByRole("list", { name: "Due soon" });
    await expect(soon).toContainText("Follow Up Person");

    // Due in a few seconds: the reminder fires on the real stack, and the bell lights without a reload.
    const tasks = (await callApi<{ items: { id: string }[] }>(page, "GET", `/api/v1/leads/${id}/tasks`)).data
      .items;
    await openApp(page, "/leads");
    await expect(page.getByRole("button", { name: "Notifications" })).toBeVisible();
    await callApi(page, "PATCH", `/api/v1/tasks/${tasks[0]!.id}`, {
      due: { at: new Date(Date.now() + 5_000).toISOString() },
    });
    await expect(page.getByRole("button", { name: "Notifications, new ones waiting" })).toBeVisible({
      timeout: 70_000,
    });

    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(page).toHaveURL(/\/today$/);
    await page.getByRole("button", { name: "Done: Follow up — Follow Up Person" }).click();
    await expect(page.getByRole("heading", { name: "All clear" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Notifications" })).toBeVisible(); // read on Today
  });

  test("screenshots and axe: Today, the drawer's next follow-up, and the sheet — both themes", async ({
    page,
  }) => {
    await openApp(page, "/leads");
    const a = await lead(page, "Shot Overdue");
    const b = await lead(page, "Shot Soon");
    await callApi(page, "POST", `/api/v1/leads/${a}/tasks`, {
      title: "Send the plan",
      due: { at: new Date(Date.now() - 3 * 3_600_000).toISOString() },
    });
    await callApi(page, "POST", `/api/v1/leads/${b}/tasks`, { title: "Call back", due: { preset: "in_1h" } });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/today");
      await expect(page.getByRole("list", { name: "Overdue" })).toContainText("Shot Overdue");
      await reviewCopy(page.locator("main"), `today-${theme}.png`);
      await expect(page.locator("main")).toHaveScreenshot(`today-${theme}.png`, { mask: volatile(page) });
      expect(await axe(page)).toEqual([]);

      await openApp(page, `/leads?lead=${b}`);
      const drawer = page.getByRole("dialog", { name: "Shot Soon" });
      const next = drawer.getByRole("region", { name: "Next follow-up" });
      await expect(next).toContainText("Call back");
      await reviewCopy(drawer, `drawer-next-follow-up-${theme}.png`);
      await expect(drawer).toHaveScreenshot(`drawer-next-follow-up-${theme}.png`, { mask: volatile(page) });
      await drawer.getByRole("button", { name: "Follow-up", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "Follow up with Shot" });
      await expect(sheet).toBeVisible();
      await reviewCopy(sheet, `follow-up-sheet-${theme}.png`);
      await expect(sheet).toHaveScreenshot(`follow-up-sheet-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await page.keyboard.press("Escape");
    }
  });
});
