import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { callApi, expect, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

const FAKE = "http://127.0.0.1:3113/__fake/state";

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
/** The licence server says so, and the instance checks now (as an admin's Check now does). */
async function licenceSays(page: Page, says: Record<string, unknown>) {
  const r = await page.request.post(FAKE, { data: says });
  expect(r.ok()).toBeTruthy();
  const c = await callApi(page, "POST", "/api/v1/licence/check");
  expect(c.status, JSON.stringify(c.data)).toBe(200);
}
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test.describe("The licence (L-A)", () => {
  test.use({ storageState: stateFile("owner") });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/settings/about");
    await licenceSays(page, {});
    await ctx.close();
  });

  test("Settings → About: the licence, Check now, and what LUME tells its licence server — both themes", async ({
    page,
  }) => {
    await openApp(page, "/settings/about");
    await licenceSays(page, {});
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/settings/about");
      const card = page.getByRole("region", { name: "Licence", exact: true });
      await expect(card).toContainText("Active");
      await expect(card).toContainText("Subscription");
      await expect(card).toContainText("LUME-E2E-0001");
      await page.getByRole("button", { name: "Check now" }).click();
      await expect(page.getByRole("button", { name: "Checked · all good" })).toBeVisible();
      await expect(page.getByRole("region", { name: "What LUME tells its licence server" })).toContainText(
        "How many leads (a number)",
      );
      await settle(page);
      await reviewCopy(page, `about-licence-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
  });

  test("grace: the amber strip for admins only, and nothing for a rep", async ({ page, browser }) => {
    await openApp(page, "/today");
    await licenceSays(page, { state: "grace", reason: "overdue", paidUntil: daysFromNow(-3) });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/today");
      const strip = page.locator('[role="status"][data-tone="grace"]');
      await expect(strip).toContainText("The licence payment is late.");
      await expect(strip).toContainText("Only admins see this.");
      await settle(page);
      await reviewCopy(page, `grace-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    const rep = await browser.newContext({ storageState: stateFile("seller") });
    const rp = await rep.newPage();
    await openApp(rp, "/today");
    await expect(rp.locator('[data-tone="grace"]')).toHaveCount(0);
    await rep.close();
  });

  test("read-only: the blue bar for everyone, writes refused in LUME's words, and the export still works", async ({
    page,
    browser,
  }) => {
    await openApp(page, "/leads");
    await licenceSays(page, { state: "read_only", reason: "overdue", paidUntil: daysFromNow(-10) });
    const refused = await callApi<{ error: { code: string; message: string } }>(
      page,
      "POST",
      "/api/v1/leads",
      {
        name: "Not while read-only",
      },
    );
    expect(refused.status).toBe(403);
    expect(refused.data.error.code).toBe("LICENSE_READ_ONLY");
    expect(refused.data.error.message).toMatch(/read-only/);
    // As the browser asks for it (the session cookie goes with the page's own requests).
    const zip = await page.evaluate(async () => {
      const r = await fetch("/api/v1/export");
      return {
        status: r.status,
        type: r.headers.get("content-type"),
        bytes: (await r.arrayBuffer()).byteLength,
      };
    });
    expect(zip).toMatchObject({ status: 200, type: "application/zip" });
    expect(zip.bytes).toBeGreaterThan(1000);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/leads");
      const bar = page.locator('[role="status"][data-tone="read_only"]');
      await expect(bar).toContainText("Read-only.");
      await expect(bar.getByRole("button", { name: "Export all data" })).toBeVisible();
      await settle(page);
      await reviewCopy(page, `read-only-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    const rep = await browser.newContext({ storageState: stateFile("seller") });
    const rp = await rep.newPage();
    await openApp(rp, "/leads");
    await expect(rp.locator('[data-tone="read_only"]')).toContainText("Read-only.");
    await rep.close();
  });

  test("suspended: LUME is paused for everyone; the owner exports everything", async ({ page, browser }) => {
    await openApp(page, "/today");
    await licenceSays(page, { state: "suspended", reason: "suspended" });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/today");
      const lock = page.getByRole("alertdialog", { name: "LUME is paused" });
      await expect(lock).toBeVisible();
      await settle(page);
      await reviewCopy(page, `paused-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.getByRole("button", { name: "Export all data" }).click();
    await expect(page.getByRole("list", { name: "Export" })).toBeVisible();
    const download = page.getByRole("link", { name: "Download" });
    await expect(download).toBeVisible({ timeout: 20_000 });
    await expect(download).toHaveAttribute("download", /^LUME-export-\d{4}-\d{2}-\d{2}\.zip$/);
    await reviewCopy(page, "paused-exported.png");
    // The browser downloads the prepared zip itself: a real zip, named for the day.
    const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
    expect(file.suggestedFilename()).toMatch(/^LUME-export-\d{4}-\d{2}-\d{2}\.zip$/);
    const { readFile } = await import("node:fs/promises");
    expect((await readFile((await file.path())!)).subarray(0, 2).toString()).toBe("PK");
    const rep = await browser.newContext({ storageState: stateFile("seller") });
    const rp = await rep.newPage();
    await openApp(rp, "/today");
    await expect(rp.getByRole("alertdialog", { name: "LUME is paused" })).toBeVisible();
    await expect(rp.getByRole("button", { name: "Export all data" })).toHaveCount(0);
    await rep.close();
  });

  test("the payment reminder: owners at sign-in, closed for the session, never a rep", async ({
    page,
    browser,
  }) => {
    await openApp(page, "/today");
    await licenceSays(page, {
      state: "grace",
      reason: "overdue",
      paidUntil: daysFromNow(-3),
      notice: {
        id: `n-${Date.now()}`,
        kind: "payment_due",
        dueDate: daysFromNow(-3),
        note: "A gentle reminder for this month. UPI or bank transfer is fine, same details as before.",
        contact: "mailto:billing@lume.test",
      },
    });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/today");
      const d = page.getByRole("dialog", { name: "Your LUME payment is due" });
      await expect(d).toContainText("A note from your LUME provider");
      await expect(d.getByRole("link", { name: "Contact about payment" })).toHaveAttribute(
        "href",
        "mailto:billing@lume.test",
      );
      await settle(page);
      await reviewCopy(page, `reminder-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.getByRole("button", { name: "I'll sort it" }).click();
    await expect(page.getByRole("dialog", { name: "Your LUME payment is due" })).toHaveCount(0);
    await openApp(page, "/today");
    await expect(page.getByRole("dialog", { name: "Your LUME payment is due" })).toHaveCount(0);
    const rep = await browser.newContext({ storageState: stateFile("seller") });
    const rp = await rep.newPage();
    await openApp(rp, "/today");
    await expect(rp.getByRole("dialog", { name: "Your LUME payment is due" })).toHaveCount(0);
    await rep.close();
  });
});
