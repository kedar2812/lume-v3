import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { PEOPLE, callApi, expect, freezeVolatile, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
const views = (page: Page) => page.getByRole("list", { name: "Views" });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const row = (page: Page, name: string) =>
  views(page).getByRole("link", { name: new RegExp(`^${escape(name)}`) });
/** The count a view's row shows, as a number ("—" is NaN). */
const countOf = async (link: Locator) =>
  Number((await link.innerText()).replace(/^[\s\S]*?(\d[\d,]*|—)\s*$/, "$1").replace(/,/g, ""));

const madeLeads: string[] = [];
async function overdueLead(page: Page, name: string, ownerName: string) {
  const people = (await callApi<{ people: { id: string; name: string }[] }>(page, "GET", "/api/v1/people"))
    .data.people;
  const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", {
    name,
    ownerId: people.find((p) => p.name === ownerName)!.id,
  });
  madeLeads.push(r.data.lead.id);
  await callApi(page, "POST", `/api/v1/leads/${r.data.lead.id}/tasks`, {
    title: "Chase",
    due: { at: new Date(Date.now() - 2 * 3_600_000).toISOString() },
    assigneeId: people.find((p) => p.name === ownerName)!.id,
  });
  return r.data.lead.id;
}

test.describe("Saved views (4B)", () => {
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await page.goto("/leads");
    if (madeLeads.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: madeLeads, action: { type: "delete" } });
    const list = await callApi<{ views: { id: string; name: string }[] }>(page, "GET", "/api/v1/views");
    for (const v of list.data.views.filter((x) => x.name === "Chase list"))
      await callApi(page, "DELETE", `/api/v1/views/${v.id}`);
    await ctx.close();
  });

  test("a new install's four views are in the sidebar, each with a count", async ({ page }) => {
    await openApp(page, "/today");
    for (const name of ["My overdue", "New today", "No reply 3+ days", "Lost — re-engage"]) {
      const link = row(page, name);
      await expect(link).toBeVisible();
      await expect.poll(() => countOf(link)).not.toBeNaN();
    }
  });

  test("a manager saves a view shared with Sales; a masked rep sees their own count, and the list agrees", async ({
    page,
    browser,
  }) => {
    await openApp(page, "/leads");
    await overdueLead(page, "Views Rep Overdue", PEOPLE.seller.name);
    await overdueLead(page, "Views Owner Overdue", PEOPLE.owner.name);
    await page.getByRole("button", { name: /more filters/i }).click();
    await page.getByRole("switch", { name: "Overdue follow-up" }).check();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Save view" }).click();
    const form = page.getByRole("dialog", { name: "Save view" });
    await form.getByRole("textbox", { name: "Name" }).fill("Chase list");
    await form.getByRole("radio", { name: "Amber" }).check({ force: true });
    await form.getByRole("radio", { name: "Share with roles" }).check();
    await form.getByRole("checkbox", { name: "Sales" }).check({ force: true });
    await form.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: "Chase list" })).toBeVisible();
    const mine = row(page, "Chase list");
    await expect(mine).toHaveAttribute("aria-current", "page");
    await expect.poll(() => countOf(mine)).toBeGreaterThanOrEqual(2);

    const repCtx = await browser.newContext({ storageState: stateFile("seller") });
    const rep = await repCtx.newPage();
    await openApp(rep, "/today");
    const theirs = row(rep, "Chase list");
    await expect(theirs).toBeVisible();
    await expect.poll(() => countOf(theirs)).toBeGreaterThanOrEqual(1);
    const repCount = await countOf(theirs);
    await theirs.click();
    await rep.waitForURL(/\/leads\?view=/);
    await expect(rep.getByTestId("lead-row")).toHaveCount(repCount);
    await expect(rep.getByTestId("lead-row").filter({ hasText: "Views Owner Overdue" })).toHaveCount(0);
    // A view shared with them isn't theirs to change.
    await expect(views(rep).getByRole("button", { name: "Edit Chase list" })).toHaveCount(0);
    await repCtx.close();
  });

  test("a lead change elsewhere moves the count, without a reload", async ({ page, browser }) => {
    await openApp(page, "/today");
    const link = row(page, "Chase list");
    await expect.poll(() => countOf(link)).not.toBeNaN();
    const before = await countOf(link);
    const other = await browser.newContext({ storageState: stateFile("owner") });
    const op = await other.newPage();
    await openApp(op, "/leads");
    await overdueLead(op, "Views Late Arrival", PEOPLE.owner.name);
    await other.close();
    await expect.poll(() => countOf(link), { timeout: 15_000 }).toBe(before + 1);
  });

  test("reorder by keyboard; delete with Undo", async ({ page }) => {
    await openApp(page, "/today");
    const names = async () =>
      (await views(page).getByRole("link").allInnerTexts()).map((t) => t.split("\n")[0]!.trim());
    const first = (await names())[0]!;
    await views(page)
      .getByRole("button", { name: `Move ${first}` })
      .focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(async () => (await names())[1]).toBe(first);
    // Focus stays on the handle, so the keyboard can move it again (4B review).
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(async () => (await names())[2]).toBe(first);
    await page.reload();
    await expect.poll(async () => (await names())[2]).toBe(first); // the order is kept, as this person's own
    await page.keyboard.press("Escape");

    await row(page, "Chase list").hover();
    await views(page).getByRole("button", { name: "Edit Chase list" }).click();
    await page.getByRole("button", { name: "Delete view" }).click();
    await expect(row(page, "Chase list")).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(row(page, "Chase list")).toBeVisible();
  });

  test("screenshots and axe: the sidebar's views, Save view, an open view and More filters — both themes", async ({
    page,
  }) => {
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/leads");
      const side = page.locator("aside").first();
      await expect(row(page, "Chase list")).toBeVisible();
      await settle(page);
      await reviewCopy(side, `sidebar-views-${theme}.png`);

      await row(page, "Chase list").click();
      await expect(page.getByRole("heading", { name: "Chase list" })).toBeVisible();
      await settle(page);
      await reviewCopy(page.locator("main"), `open-view-${theme}.png`);
      expect(await axe(page)).toEqual([]);

      await page.getByRole("button", { name: /more filters/i }).click();
      const more = page.getByRole("dialog", { name: "More filters" });
      await expect(more).toBeVisible();
      await reviewCopy(more, `more-filters-${theme}.png`);
      await expect(more).toHaveScreenshot(`more-filters-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "Save view" }).click();
      const form = page.getByRole("dialog", { name: "Save view" });
      await expect(form).toBeVisible();
      await reviewCopy(form, `save-view-${theme}.png`);
      await expect(form).toHaveScreenshot(`save-view-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await freezeVolatile(page);
    }
  });
});
