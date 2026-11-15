import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { callApi, expect, openApp, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * Your day, hover to focus and full screen (spec 2026-11-15) in the browser. This stack has no calendar, so the day is
 * follow-ups only; calls on the timeline and in the panel are the unit tests' (components/today/day).
 */
const H = 3_600_000;
const M = 60_000;
const made: string[] = [];

/** The e2e business keeps Dubai time (setup.spec). */
const dubaiHour = () =>
  Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", hourCycle: "h23" }).format(
      new Date(),
    ),
  );
/** Early in the day the follow-ups go ahead of now; later on, behind it: either way they stay on today. */
const ahead = () => dubaiHour() < 12;

async function seed(page: Page) {
  await openApp(page, "/leads");
  const at = (offset: number) => new Date(Date.now() + (ahead() ? offset : -offset)).toISOString();
  // Twelve within 22 minutes, an hour from now: a crowded stretch. One more three hours away, on its own.
  for (let i = 0; i < 12; i++) {
    const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", {
      name: `YD Lead ${i + 1}`,
    });
    made.push(r.data.lead.id);
    await callApi(page, "POST", `/api/v1/leads/${r.data.lead.id}/tasks`, {
      title: `YD check-in ${i + 1}`,
      due: { at: at(H + i * 2 * M) },
    });
  }
  const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", { name: "YD Solo Lead" });
  made.push(r.data.lead.id);
  await callApi(page, "POST", `/api/v1/leads/${r.data.lead.id}/tasks`, {
    title: "YD send the plan",
    due: { at: at(3 * H) },
  });
}

/**
 * axe, with WCAG 2.2 AA. `only` narrows it to parts of the page; whatever is stepped back behind a brought-forward
 * item is left out: it is faded on purpose while the panel shows, and comes back the moment it closes.
 */
async function axe(page: Page, only: string[] = []) {
  await settle(page);
  let b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]);
  for (const sel of only) b = b.include(sel);
  b = b.exclude("[data-day-line] [data-day-back]").exclude("[data-day-line] [data-day-item]:not([data-on])");
  const r = await b.analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

const card = (page: Page) => page.locator("[data-your-day]");
const full = (page: Page) => page.getByRole("dialog", { name: "Your day" });

test.describe("Your day", () => {
  test.describe.configure({ mode: "serial" });
  // Close to midnight, or before 1 am, "an hour away" and "three hours away" can be another day.
  test.skip(() => dubaiHour() < 1 || dubaiHour() >= 21, "near midnight the seeded day spans two days");

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    await seed(await ctx.newPage());
    await ctx.close();
  });
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await page.goto("/leads");
    if (made.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    await ctx.close();
  });

  test("on the card, hovering a dot brings it forward with its details; the rest steps back", async ({
    page,
  }) => {
    // Full motion: the rest blurs and fades. (The suite runs with reduced motion; that case is checked below.)
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openApp(page, "/today");
    const solo = card(page).getByRole("link", { name: /^YD send the plan, YD Solo Lead/ });
    await solo.hover();
    const panel = page.locator("[data-day-panel]");
    await expect(panel).toContainText("YD send the plan");
    await expect(panel).toContainText("YD Solo Lead");
    await expect(panel.getByRole("link", { name: "Open lead" })).toBeVisible();
    const crowd = card(page)
      .getByRole("button", { name: /^\d+ follow-ups: / })
      .first();
    const look = () =>
      crowd.evaluate((el) => [getComputedStyle(el).filter, Number(getComputedStyle(el).opacity)] as const);
    await expect.poll(async () => (await look())[0]).toContain("blur");
    await expect.poll(async () => (await look())[1]).toBeLessThan(0.5);
    // Reduced motion: no blur, still faded back.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(async () => (await look())[0]).toBe("none");
    await expect.poll(async () => (await look())[1]).toBeLessThan(0.5);
    // The crowded stretch is one marker; it opens the list of them all.
    await page.mouse.move(0, 0);
    await crowd.click();
    await expect(panel).toContainText(/\d+ follow-ups around/);
    await expect(panel.getByRole("link")).not.toHaveCount(0);
  });

  test("a click on the card opens the full screen; Esc closes it back", async ({ page }) => {
    await openApp(page, "/today");
    await card(page)
      .locator("[data-day-line]")
      .click({ position: { x: 4, y: 4 } });
    await expect(full(page)).toBeVisible();
    await expect(full(page)).toContainText(/follow-ups/);
    await page.keyboard.press("Escape");
    await expect(full(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open Your day full screen" })).toBeFocused();
  });

  test("a crowded day: on the timeline no two things overlap", async ({ page }) => {
    await openApp(page, "/today");
    await page.getByRole("button", { name: "Open Your day full screen" }).click();
    const chips = full(page).locator("[data-chip]");
    await expect(chips.filter({ hasText: "YD check-in 12" })).toBeVisible();
    const boxes = (await chips.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { l: r.left, r: r.right, t: r.top, b: r.bottom };
      }),
    )) as { l: number; r: number; t: number; b: number }[];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i]!, boxes[j]!];
        expect(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t, `chips ${i} and ${j} overlap`).toBe(
          true,
        );
      }
  });

  test("drag moves the timeline; zoom in, Fit day and back", async ({ page }) => {
    await openApp(page, "/today");
    await page.getByRole("button", { name: "Open Your day full screen" }).click();
    for (let i = 0; i < 3; i++) await full(page).getByRole("button", { name: "Zoom in" }).click();
    await expect(full(page).getByTestId("zoom-level")).toHaveText("246%");
    const scroller = full(page).locator("[data-day-scroller]");
    const [before, max] = await scroller.evaluate((el) => [el.scrollLeft, el.scrollWidth - el.clientWidth]);
    expect(max).toBeGreaterThan(200);
    // Late in the day it opens near the end: drag the way there's room to go.
    const by = before > max / 2 ? 120 : -120;
    const box = (await scroller.boundingBox())!;
    // Grab empty space low in the timeline, under the rows.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + by, box.y + box.height - 20, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => Math.abs((await scroller.evaluate((el) => el.scrollLeft)) - before))
      .toBeGreaterThan(60);
    await full(page).getByRole("button", { name: "Fit day" }).click();
    await expect(full(page).getByTestId("zoom-level")).toHaveText("100%");
  });

  test("List: groups in time order; Previous day and Today; Show", async ({ page }) => {
    await openApp(page, "/today");
    await page.getByRole("button", { name: "Open Your day full screen" }).click();
    const dialog = full(page);
    await dialog.getByRole("radio", { name: "List" }).click();
    const group = dialog.getByRole("group", { name: ahead() ? "Coming up" : "Overdue" });
    await expect(group).toContainText("YD check-in 1");
    await expect(group).toContainText("YD send the plan");
    const date = await dialog.locator("#your-day-full + p").textContent();
    await dialog.getByRole("button", { name: "Previous day" }).click();
    await expect(dialog.locator("#your-day-full + p")).not.toHaveText(date!);
    await expect(dialog).not.toContainText("YD check-in 1");
    await dialog.getByRole("button", { name: "Today" }).click();
    await expect(dialog.locator("#your-day-full + p")).toHaveText(date!);
    await dialog.getByRole("radio", { name: "Calls" }).click();
    await expect(dialog).toContainText("Nothing planned for this day");
    await dialog.getByRole("radio", { name: "All", exact: true }).click();
    await expect(dialog).toContainText("YD check-in 1");
  });

  test("axe: the full screen and the card's panel have no violations", async ({ page }) => {
    await openApp(page, "/today");
    await card(page)
      .getByRole("link", { name: /^YD send the plan/ })
      .focus();
    await expect(page.locator("[data-day-panel]")).toBeVisible();
    // The card and its panel (the whole of Today is checked in follow-ups.spec, with no panel over it).
    expect(await axe(page, ["[data-your-day]", "[data-day-panel]"])).toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open Your day full screen" }).click();
    await expect(full(page)).toBeVisible();
    // The full screen itself: Today behind it is dimmed by the scrim on purpose.
    expect(await axe(page, ['[role="dialog"]'])).toEqual([]);
    await full(page).getByRole("radio", { name: "List" }).click();
    expect(await axe(page, ['[role="dialog"]'])).toEqual([]);
  });

  test("a phone: it opens, the list reads, nothing scrolls the page sideways", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await openApp(page, "/today");
    await page.getByRole("button", { name: "Open Your day full screen" }).click();
    await full(page).getByRole("radio", { name: "List" }).click();
    await expect(full(page).getByRole("link", { name: /^YD send the plan/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const head = await full(page).locator("header").boundingBox();
    expect(head!.width).toBeLessThanOrEqual(375);
  });
});
