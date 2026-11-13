import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { callApi, expect, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * Control each client (spec 2026-10-17 control §2): the (fake) licence server signs a plan; LUME keeps it. Calendly is
 * the module left out here: it isn't connected in e2e, so nothing is switched off that a later spec needs.
 */
const FAKE = "http://127.0.0.1:3113/__fake/state";
const all = { googleSheets: true, webhooks: true, googleCalendar: true, calendly: true };

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
async function licenceSays(page: Page, says: Record<string, unknown>) {
  expect((await page.request.post(FAKE, { data: says })).ok()).toBeTruthy();
  const c = await callApi(page, "POST", "/api/v1/licence/check");
  expect(c.status, JSON.stringify(c.data)).toBe(200);
}

test.describe("This LUME's plan", () => {
  test.use({ storageState: stateFile("owner") });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/settings/about");
    await licenceSays(page, {});
    await ctx.close();
  });

  test("every place taken: People says so before anyone types and Send waits; the API refuses too — both themes", async ({
    page,
  }) => {
    await openApp(page, "/settings/people");
    await licenceSays(page, { plan: { places: 10000, modules: all } });
    const me = await callApi<{ plan: { taken: number } | null }>(page, "GET", "/api/v1/licence");
    const taken = me.data.plan!.taken;
    expect(taken).toBeGreaterThan(0);
    await licenceSays(page, { plan: { places: taken, modules: { ...all, calendly: false } } });

    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/settings/people");
      await expect(page.getByText(`${taken} of ${taken} places`, { exact: true })).toBeVisible();
      await expect(
        page.getByText(
          `Every place on this LUME’s plan is taken (${taken} of ${taken}). Pause someone, or ask LUME’s team about more places.`,
        ),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Send invite" })).toBeDisabled();
      await reviewCopy(page, `people-full-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }

    // A stale screen can't get past it: the API says the same.
    const r = await callApi<{ error: { code: string } }>(page, "POST", "/api/v1/invites", {
      email: "one-more@plan.example",
      name: "One More",
      roleIds: [],
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe("PLAN_PLACES");

    // One more place: room again.
    await licenceSays(page, { plan: { places: taken + 1, modules: all } });
    await openApp(page, "/settings/people");
    await expect(page.getByText(`${taken} of ${taken + 1} places`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send invite" })).toBeEnabled();
  });

  test("a tier (Plans and pricing, November 2026): Your plan says what's in it and what Max adds, and Ask about Max reaches LUME — both themes", async ({
    page,
  }) => {
    await openApp(page, "/settings/about");
    await page.request.delete("http://127.0.0.1:3113/__fake/topups");
    await licenceSays(page, { plan: { places: null, modules: all, tier: "pro" } });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/settings/about#plan");
      const card = page.getByRole("region", { name: "Your plan" });
      await expect(card).toBeVisible();
      await expect(card.getByText("Pro", { exact: true })).toBeVisible();
      const inPlan = card.getByRole("list", { name: "In your plan" });
      await expect(inPlan).toContainText("WhatsApp inbox inside LUME");
      await expect(inPlan).toContainText("LUME AI, with 1,000 AI leads a month");
      const adds = card.getByRole("list", { name: "Max adds" });
      await expect(adds).toContainText("Autopilot replies to your leads");
      await expect(adds).toContainText("3,000 AI leads a month");
      await card.scrollIntoViewIfNeeded();
      await reviewCopy(page, `plan-pro-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }

    await page
      .getByRole("region", { name: "Your plan" })
      .getByRole("button", { name: "Ask about Max" })
      .click();
    await expect(page.getByText("Asked. LUME will let you know.")).toBeVisible();
    const sent = (await (await page.request.get("http://127.0.0.1:3113/__fake/topups")).json()) as {
      topUps: { note?: string }[];
    };
    expect(sent.topUps.map((t) => t.note)).toEqual(["They'd like to move to Max."]);

    // Asking about a tier this LUME already has is refused in words, whatever a stale screen sends.
    const r = await callApi<{ error: { code: string; message: string } }>(page, "POST", "/api/v1/plan/ask", {
      tier: "pro",
    });
    expect(r.status).toBe(409);
    expect(r.data.error.message).toBe("This LUME already has everything in Pro.");

    // No tier: no card, nothing locked.
    await licenceSays(page, { plan: { places: null, modules: all } });
    await openApp(page, "/settings/about");
    await expect(page.getByRole("region", { name: "Your plan" })).toHaveCount(0);
  });

  test("a module left out: its card says so and Connect is gone — both themes", async ({ page }) => {
    await openApp(page, "/settings/integrations");
    await licenceSays(page, { plan: { places: null, modules: { ...all, calendly: false } } });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/settings/integrations");
      const card = page.getByRole("article", { name: /^Calendly/ });
      await expect(card.getByText("Not in this LUME’s plan")).toBeVisible();
      await expect(
        card.getByText("Its settings are kept. Ask LUME’s team to add it to your plan."),
      ).toBeVisible();
      await expect(card.getByRole("button", { name: "Connect Calendly" })).toHaveCount(0);
      await card.scrollIntoViewIfNeeded();
      await reviewCopy(page, `integrations-calendly-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    // Back in the plan: Connect is there again.
    await licenceSays(page, { plan: { places: null, modules: all } });
    await openApp(page, "/settings/integrations");
    await expect(
      page.getByRole("article", { name: /^Calendly/ }).getByRole("button", { name: "Connect Calendly" }),
    ).toBeVisible();
  });
});
