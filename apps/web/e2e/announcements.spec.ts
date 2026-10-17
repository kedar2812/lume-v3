import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { callApi, expect, hydrated, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/** From LUME's team (spec 2026-10-16 fleet §4): signed by the (fake) licence server, shown in LUME, Got it. */
const FAKE = "http://127.0.0.1:3113/__fake/state";
const A = "0190e0c0-0000-7000-8000-0000000000a1";
const B = "0190e0c0-0000-7000-8000-0000000000b2";
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const announcements = [
  {
    id: A,
    title: "LUME will be updated on Sunday night",
    body: "LUME will be away for about 30 minutes while it’s updated. Anything you’re typing then may need saving again. Nothing else changes for you, and nothing you’ve saved is touched.",
    kind: "maintenance",
    audience: "admins",
    windowStart: inDays(2),
    windowEnd: new Date(Date.parse(inDays(2)) + 30 * 60_000).toISOString(),
    endsAt: inDays(3),
  },
  {
    id: B,
    title: "Snooze a follow-up by an hour",
    body: "A follow-up reminder can now wait an hour as well as until tomorrow: open it and choose Snooze.",
    kind: "update",
    audience: "everyone",
    windowStart: null,
    windowEnd: null,
    endsAt: inDays(14),
  },
];

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
const strip = (page: Page) => page.getByRole("region", { name: "From LUME’s team", exact: true });

test.describe("From LUME's team", () => {
  test.use({ storageState: stateFile("owner") });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/settings/about");
    await licenceSays(page, {});
    await ctx.close();
  });

  test("a check-in carries health and says it can show them; the owner sees both, one at a time — both themes", async ({
    page,
  }) => {
    await openApp(page, "/today");
    await licenceSays(page, { announcements });
    const sent = (await (await page.request.get(FAKE)).json()) as { lastCheck: Record<string, unknown> };
    expect(sent.lastCheck.accepts).toEqual(["announcements", "plan"]);
    expect(Object.keys(sent.lastCheck.health as object).sort()).toEqual(
      [
        "dbBytes",
        "diskFreePct",
        "errors24h",
        "modulesOn",
        "problems",
        "queue",
        "remindersLate",
        "restoreTest",
        "sourcesNeedingAttention",
        "uptimeS",
      ].sort(),
    );
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/leads");
      await expect(strip(page)).toContainText("LUME will be updated on Sunday night");
      await expect(strip(page)).toContainText("1 more after this");
      await reviewCopy(page, `strip-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    // Two lines hold it at this width: no More that would show nothing new.
    await expect(strip(page).getByRole("button", { name: "More" })).toHaveCount(0);
    await strip(page).getByRole("button", { name: "Got it" }).click();
    await expect(strip(page)).toContainText("Snooze a follow-up by an hour");
    await reviewCopy(page, "strip-next.png");
    // Kept on the server: another page, the same.
    await openApp(page, "/today");
    await expect(strip(page)).toContainText("Snooze a follow-up by an hour");
    await openApp(page, "/settings/about");
    const about = page.getByRole("region", { name: "From LUME’s team, now showing" });
    await expect(about).toContainText("LUME will be updated on Sunday night");
    await expect(about).toContainText("Snooze a follow-up by an hour");
    await reviewCopy(page, "about-announcements.png");
    // Got it goes back as a count with the next check-in.
    await callApi(page, "POST", "/api/v1/licence/check");
    const after = (await (await page.request.get(FAKE)).json()) as {
      lastCheck: { seen: { id: string; people: number }[] };
    };
    expect(after.lastCheck.seen).toEqual([
      { id: A, people: 1 },
      { id: B, people: 0 },
    ]);
  });

  test("a sales rep sees only what's for everyone, and on a phone the strip takes the full width", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      storageState: stateFile("seller"),
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.goto("/leads");
    await hydrated(page);
    await expect(strip(page)).toContainText("Snooze a follow-up by an hour");
    await expect(strip(page)).not.toContainText("Sunday night");
    const got = (await strip(page).getByRole("button", { name: "Got it" }).boundingBox())!;
    expect(got.height).toBeGreaterThanOrEqual(44);
    await reviewCopy(page, "strip-phone.png");
    expect(await axe(page)).toEqual([]);
    await ctx.close();
  });
});
