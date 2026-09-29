import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { callApi, expect, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

const MIN = 60_000;
async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
type Stage = { id: string; name: string; kind: string };
async function stageNamed(page: Page, name: string): Promise<Stage> {
  const { pipelines } = (
    await callApi<{ pipelines: { isDefault: boolean; stages: Stage[] }[] }>(page, "GET", "/api/v1/pipelines")
  ).data;
  return pipelines.find((p) => p.isDefault)!.stages.find((s) => s.name === name)!;
}
const made: string[] = [];
async function lead(page: Page, name: string): Promise<string> {
  const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", { name });
  made.push(r.data.lead.id);
  return r.data.lead.id;
}
const openTasks = async (page: Page, id: string) =>
  (
    await callApi<{ items: { title: string; status: string; dueAt: string }[] }>(
      page,
      "GET",
      `/api/v1/leads/${id}/tasks`,
    )
  ).data.items.filter((t) => t.status === "open");

test.describe("Stage automations, time choices and System health (3C)", () => {
  test.use({ storageState: stateFile("owner") });

  // The workspace as it was: Replied does nothing on its own, 3A's time choices, and the leads gone.
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await page.goto("/leads");
    const replied = await stageNamed(page, "Replied");
    await callApi(page, "PATCH", `/api/v1/stages/${replied.id}`, { onEnter: { rules: [] } });
    await callApi(page, "PUT", "/api/v1/settings/follow-ups", {
      duePresets: [
        { id: "in_1h", label: "In 1 hour", rule: { in: { n: 1, unit: "hour" } } },
        { id: "in_3h", label: "In 3 hours", rule: { in: { n: 3, unit: "hour" } } },
        { id: "tomorrow_10", label: "Tomorrow 10:00", rule: { at: { days: 1, time: "10:00" } } },
        { id: "in_2d", label: "In 2 days", rule: { in: { n: 2, unit: "day" } } },
        { id: "next_monday", label: "Next Monday", rule: { weekday: { day: 1, time: "10:00" } } },
      ],
    });
    if (made.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    await ctx.close();
  });

  test("an admin sets what Replied does; a lead moved there has its follow-up, and its history says so", async ({
    page,
  }) => {
    await openApp(page, "/settings/pipeline");
    await page.getByRole("button", { name: "Automations for Replied" }).click();
    const sheet = page.getByRole("dialog", { name: "When a lead enters Replied" });
    await sheet.getByRole("button", { name: "Set a follow-up" }).click();
    await sheet.getByLabel("Follow-up title").fill("Send the plan");
    await sheet.getByLabel("How long after").fill("2");
    await sheet.getByLabel("Hours or days").selectOption("day");
    await sheet.getByRole("button", { name: "Tell someone" }).click();
    await sheet.getByText("The lead's owner", { exact: true }).click();
    await expect(
      sheet.getByText("Sets a follow-up for the lead's owner in 2 days: Send the plan"),
    ).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(sheet, `automation-sheet-${theme}.png`);
      await expect(sheet).toHaveScreenshot(`automation-sheet-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet).toBeHidden();
    const summary = page.getByRole("list", { name: "What each stage does" });
    await expect(summary).toContainText("Sets a follow-up for the lead's owner in 2 days: Send the plan");
    await reviewCopy(page.locator("main"), "pipeline-with-automations-light.png");

    const id = await lead(page, "Rule Follower");
    const replied = await stageNamed(page, "Replied");
    await callApi(page, "POST", `/api/v1/leads/${id}/stage`, { stageId: replied.id });
    expect((await openTasks(page, id)).map((t) => t.title)).toEqual(["Send the plan"]);
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Rule Follower" });
    await expect(drawer.getByRole("region", { name: "Next follow-up" })).toContainText("Send the plan");
    await drawer.getByRole("tab", { name: "History" }).click();
    await expect(drawer.getByText("LUME set a follow-up")).toBeVisible();
    await reviewCopy(drawer, "drawer-automation-history-light.png");
  });

  test("a win clears the lead's open follow-ups (a new install's Won does that from the start)", async ({
    page,
  }) => {
    await openApp(page, "/leads");
    const id = await lead(page, "Closing Soon");
    await callApi(page, "POST", `/api/v1/leads/${id}/tasks`, {
      title: "Send the contract",
      due: { at: new Date(Date.now() + 60 * MIN).toISOString() },
    });
    expect(await openTasks(page, id)).toHaveLength(1);
    const won = await stageNamed(page, "Won");
    await callApi(page, "POST", `/api/v1/leads/${id}/stage`, { stageId: won.id });
    expect(await openTasks(page, id)).toHaveLength(0);
  });

  test("a time choice an admin adds is in the follow-up sheet, and lands when it says", async ({ page }) => {
    await openApp(page, "/settings/follow-ups");
    const choices = page.getByRole("list", { name: "Time choices" });
    await page.getByRole("textbox", { name: "New time choice" }).fill("In 30 minutes");
    await page.getByRole("textbox", { name: "New time choice" }).press("Enter");
    await choices.getByRole("button", { name: "When for In 30 minutes" }).click();
    await page.getByLabel("How many", { exact: true }).fill("30");
    await page.getByLabel("Minutes, hours or days").selectOption("minute");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(choices.getByRole("button", { name: "When for In 30 minutes" })).toContainText(
      "in 30 minutes",
    );
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page.locator("main"), `follow-up-settings-3c-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });

    const id = await lead(page, "Half Hour");
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Half Hour" });
    await drawer.getByRole("button", { name: "Follow-up", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Follow up with Half" });
    await sheet.getByText("In 30 minutes", { exact: true }).click();
    const before = Date.now();
    await sheet.getByRole("button", { name: "Set follow-up" }).click();
    await expect(sheet).toBeHidden();
    const [t] = await openTasks(page, id);
    const off = new Date(t!.dueAt).getTime() - before;
    expect(off).toBeGreaterThan(28 * MIN);
    expect(off).toBeLessThan(32 * MIN);
  });

  test("working hours on Business, and System health at a glance", async ({ page }) => {
    await openApp(page, "/settings/business");
    const hours = page.getByRole("form", { name: "Working hours" });
    await expect(hours.getByRole("checkbox", { name: "Monday" })).toBeChecked();
    await reviewCopy(hours, "working-hours-light.png");

    await openApp(page, "/settings/health");
    const headline = page.getByRole("heading", { level: 2 }).first();
    await expect(headline).toHaveText(/Everything is running|needs? a look/);
    const reminders = page.getByRole("region", { name: "Follow-up reminders" });
    await expect(reminders).toContainText("late");
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page.locator("main"), `system-health-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
  });
});
