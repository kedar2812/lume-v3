import AxeBuilder from "@axe-core/playwright";
import type { Browser, Page } from "@playwright/test";
import { forgetSeededMeetings, seedMeetings } from "./db";
import {
  PEOPLE,
  callApi,
  expect,
  freezeVolatile,
  hydrated,
  openApp,
  reviewCopy,
  stateFile,
  test,
} from "./fixtures";
import { settle } from "./settle";

/**
 * The Calendar (5D) on the real stack. The meetings are written straight into the database: bringing them in
 * (Google's sync through the relay, Calendly's webhook) is the API's own tests' work, against fakes.
 *
 * The pictures are of one fixed week, Monday September 14, 2026, with the browser's clock stopped at 2:16 pm
 * on the business's clock (Dubai): the same picture every run. What the server judges (Log outcome only once a
 * meeting has started) uses meetings around the real time instead.
 */
const dubai = (day: string, time: string) => new Date(`${day}T${time}:00+04:00`);
const FROZEN = dubai("2026-09-14", "14:16");
/**
 * A fresh window for one theme, its clock starting at FROZEN and ticking on in real time: a stopped clock
 * would stop motion's own animations too (the page would never settle), and setting a running clock back
 * strands the ones already timed. So each theme gets its own window, and its own clock.
 */
async function pictured(browser: Browser, theme: "light" | "dark", viewport = { width: 1366, height: 800 }) {
  const ctx = await browser.newContext({
    storageState: stateFile("owner"),
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport,
  });
  const page = await ctx.newPage();
  await page.clock.install({ time: FROZEN });
  await page.clock.resume();
  return { ctx, page };
}
/** openApp for a hand-made window: the fixture's page waits for hydration on its own; this one must. */
async function open(page: Page, path: string) {
  await openApp(page, path);
  await hydrated(page);
}

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
const volatile = (page: Page) => [page.locator("[data-volatile]")];

const made: string[] = [];
const lead: Record<string, string> = {};
async function asOwner(browser: Browser) {
  const ctx = await browser.newContext({ storageState: stateFile("owner") });
  const page = await ctx.newPage();
  await page.goto("/leads");
  return { ctx, page };
}
async function newLead(page: Page, name: string): Promise<string> {
  const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", { name });
  made.push(r.data.lead.id);
  return r.data.lead.id;
}

test.describe("Calendar (5D)", () => {
  test.beforeAll(async ({ browser }) => {
    const { ctx, page } = await asOwner(browser);
    for (const name of [
      "Priya Menon",
      "Karim Aziz",
      "Dana Whitfield",
      "Aisha Khan",
      "Omar Rahman",
      "Lina Farah",
    ])
      lead[name] = await newLead(page, name);
    await ctx.close();
    const owner = PEOPLE.owner.email;
    await seedMeetings([
      {
        leadId: lead["Priya Menon"]!,
        ownerEmail: owner,
        title: "Discovery call",
        startsAt: dubai("2026-09-14", "09:00"),
        status: "completed",
        outcomeNote: "Wants the annual plan",
        matchedBy: "attendee",
      },
      {
        leadId: lead["Karim Aziz"]!,
        ownerEmail: owner,
        title: "Pricing walkthrough",
        startsAt: dubai("2026-09-14", "11:30"),
        matchedBy: "attendee",
      },
      {
        leadId: lead["Dana Whitfield"]!,
        ownerEmail: owner,
        title: "Discovery call",
        startsAt: dubai("2026-09-14", "14:30"),
      },
      {
        leadId: lead["Aisha Khan"]!,
        ownerEmail: PEOPLE.seller.email,
        title: "Check-in",
        startsAt: dubai("2026-09-14", "16:00"),
        matchedBy: "attendee",
      },
      {
        leadId: lead["Omar Rahman"]!,
        ownerEmail: owner,
        title: "Programme fit call",
        startsAt: dubai("2026-09-15", "10:30"),
        matchedBy: "title",
      },
      {
        leadId: lead["Lina Farah"]!,
        ownerEmail: owner,
        title: "Discovery call",
        startsAt: dubai("2026-09-16", "13:00"),
        status: "no_show",
      },
    ]);
  });

  // Leave the workspace as it was: later specs photograph Today.
  test.afterAll(async ({ browser }) => {
    await forgetSeededMeetings();
    const { ctx, page } = await asOwner(browser);
    if (made.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    await ctx.close();
  });

  test("the agenda, the week, a meeting and Log outcome: as approved, in both themes", async ({
    browser,
  }) => {
    for (const theme of ["light", "dark"] as const) {
      const { ctx, page } = await pictured(browser, theme);
      await open(page, "/calendar");
      const today = page.getByRole("region", { name: "Today · September 14, Monday" });
      await expect(today.getByRole("button", { name: /^Discovery call/ })).toHaveCount(2);
      await expect(page.getByRole("region", { name: "Tomorrow · September 15, Tuesday" })).toContainText(
        "Programme fit call",
      );
      await settle(page);
      await reviewCopy(page, `agenda-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await expect(page.locator("main")).toHaveScreenshot(`agenda-${theme}.png`);

      await page.getByRole("radio", { name: "Week" }).click();
      await expect(page).toHaveURL(/view=week/);
      await settle(page);
      await reviewCopy(page, `week-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await expect(page.locator("main")).toHaveScreenshot(`week-${theme}.png`);
      await page.getByRole("radio", { name: "Agenda" }).click();

      // A meeting that ended with no outcome: its drawer offers Log outcome.
      await today.getByRole("button", { name: /^Pricing walkthrough/ }).click();
      const drawer = page.getByRole("dialog", { name: "Pricing walkthrough" });
      await expect(drawer).toContainText("Karim Aziz");
      await settle(page);
      await reviewCopy(page, `meeting-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await expect(drawer).toHaveScreenshot(`meeting-${theme}.png`);

      await drawer.getByRole("button", { name: "Log outcome" }).click();
      const outcome = page.getByRole("dialog", { name: "How did it go with Karim?" });
      await outcome.getByRole("radio", { name: /Held/ }).click();
      await expect(outcome.getByRole("switch", { name: "Move Karim to Message sent" })).toBeChecked();
      await settle(page);
      await reviewCopy(page, `log-outcome-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await expect(outcome).toHaveScreenshot(`log-outcome-${theme}.png`);
      await outcome.getByRole("button", { name: "Later" }).click();
      await expect(outcome).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await ctx.close();
    }
  });

  test("the lead's drawer: the next meeting, and every meeting in its own tab", async ({ browser }) => {
    for (const theme of ["light", "dark"] as const) {
      const { ctx, page } = await pictured(browser, theme);
      await open(page, `/leads?lead=${lead["Dana Whitfield"]}`);
      const drawer = page.getByRole("dialog", { name: "Dana Whitfield" });
      const next = drawer.getByRole("region", { name: "Next meeting" });
      await expect(next).toContainText("in 14 min");
      await expect(next.getByRole("link", { name: "Open in Calendar" })).toHaveAttribute(
        "href",
        /\/calendar\?d=2026-09-14&m=/,
      );
      await settle(page);
      await reviewCopy(page, `drawer-next-meeting-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await freezeVolatile(page);
      await expect(drawer).toHaveScreenshot(`drawer-next-meeting-${theme}.png`, { mask: volatile(page) });

      await open(page, `/leads?lead=${lead["Priya Menon"]}`);
      const priya = page.getByRole("dialog", { name: "Priya Menon" });
      await priya.getByRole("tab", { name: /Meetings/ }).click();
      const earlier = priya.getByRole("list", { name: "Earlier" });
      await expect(earlier).toContainText("Held");
      await expect(earlier).toContainText("Wants the annual plan");
      await settle(page);
      await reviewCopy(page, `drawer-meetings-tab-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await ctx.close();
    }
  });

  test("on a phone (390 px): the next call, Today and Tomorrow, and a sheet that flicks away", async ({
    browser,
  }) => {
    for (const theme of ["light", "dark"] as const) {
      const { ctx, page } = await pictured(browser, theme, { width: 390, height: 844 });
      await open(page, "/calendar");
      const hero = page.getByRole("region", { name: "Next meeting" });
      await expect(hero).toContainText("Next · in 14 min");
      await expect(hero).toContainText("Dana Whitfield");
      await expect(page.getByRole("region", { name: "Today" })).toContainText("4 meetings");
      await expect(page.getByRole("region", { name: "Tomorrow" })).toContainText("1 meeting");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await settle(page);
      await reviewCopy(page, `phone-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await expect(page).toHaveScreenshot(`phone-${theme}.png`);

      await page
        .getByRole("region", { name: "Today" })
        .getByRole("button", { name: /Karim Aziz/ })
        .click();
      const sheet = page.getByRole("dialog", { name: "Karim Aziz" });
      await expect(sheet.getByRole("button", { name: "Log how it went" })).toBeVisible();
      await settle(page);
      await reviewCopy(page, `phone-sheet-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await expect(page).toHaveScreenshot(`phone-sheet-${theme}.png`);

      // A real flick down the handle: 100 px at once is fast, so where it's headed is far past 220 px.
      const grab = sheet.getByRole("button", { name: "Drag down to close" });
      const box = (await grab.boundingBox())!;
      const x = box.x + box.width / 2;
      await page.mouse.move(x, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, box.y + box.height / 2 + 100, { steps: 5 });
      await page.mouse.up();
      await expect(sheet).toBeHidden();
      await ctx.close();
    }
  });

  test("Log outcome on a call that just ended: recorded, the lead moved on, and Today says so", async ({
    page,
  }) => {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", hourCycle: "h23" }).format(
        new Date(),
      ),
    );
    test.skip(hour < 2, "a call that ended an hour ago must be on today's date");
    await openApp(page, "/leads");
    const id = await newLead(page, "Outcome Person");
    await seedMeetings([
      {
        leadId: id,
        ownerEmail: PEOPLE.owner.email,
        title: "Strategy call",
        startsAt: new Date(Date.now() - 90 * 60_000),
        matchedBy: "attendee",
      },
    ]);

    await openApp(page, "/today");
    // A call that ended is owed its outcome in Up next (the control centre).
    const calls = page.getByRole("list", { name: "Up next" });
    await expect(calls).toContainText("Outcome Person");
    await calls.getByRole("button", { name: "Log outcome" }).click();
    const outcome = page.getByRole("dialog", { name: "How did it go with Outcome?" });
    await outcome.getByRole("radio", { name: /Held/ }).click();
    await outcome.getByRole("textbox", { name: "Note" }).fill("Signing next week");
    await outcome.getByRole("button", { name: "Save outcome" }).click();
    await expect(outcome).toBeHidden();
    // Logged: it leaves Up next, and Your day shows it held.
    await expect(calls.getByRole("button", { name: "Log outcome" })).toBeHidden();
    await expect(
      page.getByRole("link", { name: /^Strategy call with Outcome Person at .+, over$/ }),
    ).toBeVisible();

    // Recorded on the meeting, and the lead moved on to the next open stage.
    const l = await callApi<{ lead: { stageId: string; pipelineId: string } }>(
      page,
      "GET",
      `/api/v1/leads/${id}`,
    );
    const p = await callApi<{ pipelines: { id: string; stages: { id: string; name: string }[] }[] }>(
      page,
      "GET",
      "/api/v1/pipelines",
    );
    const stage = p.data.pipelines.flatMap((x) => x.stages).find((s) => s.id === l.data.lead.stageId);
    expect(stage?.name).toBe("Message sent");
    const m = await callApi<{ meetings: { status: string; outcomeNote: string | null }[] }>(
      page,
      "GET",
      `/api/v1/leads/${id}/meetings`,
    );
    expect(m.data.meetings[0]).toMatchObject({ status: "completed", outcomeNote: "Signing next week" });
  });

  test("the gear opens Settings → Calendar, and ‹ Calendar comes back to the same week", async ({ page }) => {
    await openApp(page, "/calendar?view=week&d=2026-09-14");
    await page.getByRole("button", { name: "Calendar settings" }).click();
    await expect(page).toHaveURL(/\/settings\/calendar$/);
    await page.getByRole("link", { name: "‹ Calendar" }).click();
    await expect(page).toHaveURL(/\/calendar\?view=week&d=2026-09-14$/);
    await expect(page.getByRole("radio", { name: "Week" })).toBeChecked();

    // Browser Back does the same.
    await page.getByRole("button", { name: "Calendar settings" }).click();
    await expect(page).toHaveURL(/\/settings\/calendar$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/calendar\?view=week&d=2026-09-14$/);
  });
});
