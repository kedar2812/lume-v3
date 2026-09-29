import AxeBuilder from "@axe-core/playwright";
import type { BrowserContext, Page } from "@playwright/test";
import { backdateLost } from "./db";
import { PEOPLE, callApi, expect, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

/** WhatsApp itself is never contacted from a test run: its pages answer with a stub. */
const stubWhatsApp = (context: BrowserContext) =>
  context.route(/^https:\/\/(wa\.me|api\.whatsapp\.com)\//, (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp</title>" }),
  );
/** Send: a real new tab pointed at wa.me, closed again; back in LUME, which asks Sent?. */
async function sendOne(page: Page, context: BrowserContext, number: string) {
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Send" }).click(),
  ]);
  await tab.waitForURL(new RegExp(`^https://wa\\.me/${number}`));
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.close();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("group", { name: "Was the WhatsApp message sent?" })).toBeVisible();
}

const made: string[] = [];
type Owner = { page: Page; close: () => Promise<void> };
async function asOwner(browser: import("@playwright/test").Browser): Promise<Owner> {
  const ctx = await browser.newContext({ storageState: stateFile("owner") });
  const page = await ctx.newPage();
  await openApp(page, "/leads");
  return { page, close: () => ctx.close() };
}
/** Leads of Noor's (Sales, masked), made by the owner; lost a month ago when asked. */
async function noorsLeads(
  o: Owner,
  leads: { name: string; phone: string }[],
  lost = false,
): Promise<string[]> {
  const people = (await callApi<{ people: { id: string; name: string }[] }>(o.page, "GET", "/api/v1/people"))
    .data.people;
  const noor = people.find((p) => p.name === PEOPLE.seller.name)!.id;
  const ids: string[] = [];
  for (const l of leads) {
    const r = await callApi<{ lead: { id: string } }>(o.page, "POST", "/api/v1/leads", {
      ...l,
      ownerId: noor,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    ids.push(r.data.lead.id);
  }
  made.push(...ids);
  if (lost) {
    const { pipelines } = (
      await callApi<{ pipelines: { stages: { id: string; kind: string }[] }[] }>(
        o.page,
        "GET",
        "/api/v1/pipelines",
      )
    ).data;
    const lostStage = pipelines[0]!.stages.find((s) => s.kind === "lost")!;
    const reasons = (await callApi<{ lostReasons: { id: string }[] }>(o.page, "GET", "/api/v1/lost-reasons"))
      .data.lostReasons;
    for (const id of ids) {
      const r = await callApi(o.page, "POST", `/api/v1/leads/${id}/stage`, {
        stageId: lostStage.id,
        lostReasonId: reasons[0]!.id,
      });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
    }
    await backdateLost(ids, 31);
  }
  return ids;
}
/** A run started through the API, in a starter template's words. */
async function startRun(page: Page, leadIds: string[], template = "Gentle nudge"): Promise<string> {
  const templates = (
    await callApi<{ templates: { id: string; name: string }[] }>(page, "GET", "/api/v1/templates")
  ).data.templates;
  const r = await callApi<{ queue: { id: string } }>(page, "POST", "/api/v1/queues", {
    leadIds,
    templateId: templates.find((x) => x.name === template)!.id,
  });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.queue.id;
}
/** A run left open by a test is ended, so the next can start one. */
async function endOpenRun(page: Page) {
  const cur = await callApi<{ id: string } | null>(page, "GET", "/api/v1/queues/current");
  if (cur.data) await callApi(page, "POST", `/api/v1/queues/${cur.data.id}/cancel`);
}
const bodyHasNoNumber = async (page: Page, digits: string) => {
  await expect(page.locator("body")).not.toContainText(digits);
  await expect(page.locator("body")).not.toContainText("wa.me");
};

test.describe("The send queue (4C)", () => {
  test.use({ storageState: stateFile("seller") });

  test.afterAll(async ({ browser }) => {
    const o = await asOwner(browser);
    if (made.length)
      await callApi(o.page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    await callApi(o.page, "PUT", "/api/v1/settings/messaging", { dailyCap: 150 });
    await o.close();
  });

  test("a masked rep runs a three-lead queue from “Lost — re-engage”: sent, skipped, not sent — the number never on the page", async ({
    page,
    context,
    browser,
  }) => {
    const o = await asOwner(browser);
    await noorsLeads(
      o,
      [
        { name: "Queue Ada", phone: "+971509991101" },
        { name: "Queue Bram", phone: "+971509991102" },
        { name: "Queue Cleo", phone: "+971509991103" },
      ],
      true,
    );
    await o.close();
    await stubWhatsApp(context);
    await openApp(page, "/leads");
    await endOpenRun(page);
    const views = (await callApi<{ views: { id: string; name: string }[] }>(page, "GET", "/api/v1/views"))
      .data.views;
    const lostView = views.find((v) => v.name === "Lost — re-engage")!;
    await openApp(page, `/leads?view=${lostView.id}`);
    await page.getByRole("button", { name: "Message these" }).click();
    const sheet = page.getByRole("dialog", { name: "Start a send queue" });
    await expect(sheet.getByText("3 leads")).toBeVisible();
    // A lost-leads view suggests Re-engagement first.
    await expect(sheet.getByRole("radio").first()).toHaveAttribute("data-name", "Checking back in");
    await expect(sheet.getByRole("radio", { name: /Checking back in/ })).toBeChecked();
    await sheet.getByRole("button", { name: "Start" }).click();

    await page.waitForURL(/\/queue\/[0-9a-f-]{36}$/);
    const run = page.getByRole("dialog", { name: "Send queue" });
    // In the view's own order: newest first.
    await expect(run.getByRole("heading", { name: "Queue Cleo" })).toBeVisible();
    await expect(run.getByText("0 of 3")).toBeVisible();
    await expect(run.getByRole("textbox", { name: "Message" })).toHaveValue(/^Hi Queue, it's been a while!/);
    await bodyHasNoNumber(page, "9991103");

    await sendOne(page, context, "971509991103");
    await run.getByRole("button", { name: "Yes, sent" }).click();
    await expect(run.getByRole("heading", { name: "Queue Bram" })).toBeVisible();
    await expect(run.getByText("1 of 3")).toBeVisible();
    await bodyHasNoNumber(page, "9991102");

    await page.keyboard.press("s");
    await expect(run.getByRole("heading", { name: "Queue Ada" })).toBeVisible();
    await sendOne(page, context, "971509991101");
    await page.keyboard.press("n");

    const summary = run.getByRole("region", { name: "Run finished" });
    await expect(summary).toContainText("1 sent");
    await expect(summary).toContainText("1 not sent");
    await expect(summary).toContainText("1 skipped");
    await bodyHasNoNumber(page, "99911");
    await summary.getByRole("button", { name: "Done" }).click();
    await page.waitForURL(/\/today$/);
  });

  test("pause, leave and pick it up again from the top bar and Today; a lead lost mid-run is skipped with why", async ({
    page,
    context,
    browser,
  }) => {
    const o = await asOwner(browser);
    const [a, b] = await noorsLeads(o, [
      { name: "Pause Ana", phone: "+971509991201" },
      { name: "Pause Ben", phone: "+971509991202" },
    ]);
    await stubWhatsApp(context);
    await openApp(page, "/leads");
    await endOpenRun(page);
    await openApp(page, `/queue/${await startRun(page, [a, b])}`);
    const run = page.getByRole("dialog", { name: "Send queue" });
    await expect(run.getByRole("textbox", { name: "Message" })).toHaveValue(/^Hi Pause, /);
    await page.keyboard.press("p");
    await expect(run.getByText("Paused", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.waitForURL(/\/today$/);
    await expect(page.getByRole("region", { name: "Your send queue" })).toContainText(
      "Your send queue is paused",
    );
    await page.getByRole("link", { name: "Resume · 0 of 2" }).first().click();
    await page.waitForURL(/\/queue\//);
    await expect(run.getByRole("button", { name: "Resume" })).toBeVisible();
    await run.getByRole("button", { name: "Resume" }).click();
    await expect(run.getByRole("textbox", { name: "Message" })).toHaveValue(/^Hi Pause, /);

    // The owner takes Ana's number away: Send says why, and the run moves on to Ben.
    const ver = (await callApi<{ lead: { version: number } }>(o.page, "GET", `/api/v1/leads/${a}`)).data.lead
      .version;
    const cleared = await callApi(
      o.page,
      "PATCH",
      `/api/v1/leads/${a}`,
      { phone: null },
      { "if-match": String(ver) },
    );
    expect(cleared.status, JSON.stringify(cleared.data)).toBe(200);
    await o.close();
    await run.getByRole("button", { name: "Send" }).click();
    await expect(run.getByText("No WhatsApp number")).toBeVisible();
    await expect(run.getByRole("heading", { name: "Pause Ben" })).toBeVisible();
    await endOpenRun(page);
  });

  test("the daily cap pauses the run, in LUME's words", async ({ page, context, browser }) => {
    const o = await asOwner(browser);
    const [a, b] = await noorsLeads(o, [
      { name: "Cap Ida", phone: "+971509991301" },
      { name: "Cap Jon", phone: "+971509991302" },
    ]);
    await stubWhatsApp(context);
    await openApp(page, "/leads");
    await endOpenRun(page);
    const plan = await callApi<{ today: { sent: number } }>(page, "POST", "/api/v1/queues/plan", {
      leadIds: [a],
    });
    const cap = plan.data.today.sent + 1;
    expect((await callApi(o.page, "PUT", "/api/v1/settings/messaging", { dailyCap: cap })).status).toBe(200);
    await o.close();
    await openApp(page, `/queue/${await startRun(page, [a, b])}`);
    const run = page.getByRole("dialog", { name: "Send queue" });
    await sendOne(page, context, "971509991301");
    await run.getByRole("button", { name: "Yes, sent" }).click();
    await expect(run.getByRole("heading", { name: "Cap Jon" })).toBeVisible();
    await run.getByRole("button", { name: "Send" }).click();
    try {
      await expect(
        run.getByText(`You've sent today's ${cap}; the run is paused until tomorrow`),
      ).toBeVisible();
      await expect(run.getByRole("button", { name: "Resume" })).toBeVisible();
    } finally {
      await endOpenRun(page);
      const back = await asOwner(browser);
      await callApi(back.page, "PUT", "/api/v1/settings/messaging", { dailyCap: 150 });
      await back.close();
    }
  });

  test("review copies and axe: the start sheet, the run (a card, Sent?, a skip) and the summary — both themes", async ({
    page,
    context,
    browser,
  }) => {
    await stubWhatsApp(context);
    for (const theme of ["light", "dark"] as const) {
      const o = await asOwner(browser);
      const ids = await noorsLeads(o, [
        { name: `Shot Lina ${theme}`, phone: "+971509991401" },
        { name: `Shot Omar ${theme}`, phone: "+971509991402" },
      ]);
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/leads");
      await endOpenRun(page);
      await page.getByRole("searchbox").first().fill(`Shot Lina ${theme}`);
      await page.getByRole("checkbox", { name: `Select Shot Lina ${theme}` }).check();
      const bar = page.getByRole("toolbar", { name: "Bulk actions" });
      await bar.getByRole("button", { name: "Message" }).click();
      const sheet = page.getByRole("dialog", { name: "Start a send queue" });
      await expect(sheet.getByText("1 lead")).toBeVisible();
      await settle(page);
      await reviewCopy(page, `start-sheet-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await page.keyboard.press("Escape");

      const runId = await startRun(page, ids);
      await openApp(page, `/queue/${runId}`);
      const run = page.getByRole("dialog", { name: "Send queue" });
      await expect(run.getByRole("textbox", { name: "Message" })).toHaveValue(/^Hi Shot, /);
      await settle(page);
      await reviewCopy(page, `run-card-${theme}.png`);
      expect(await axe(page)).toEqual([]);

      await sendOne(page, context, "971509991401");
      await settle(page);
      await reviewCopy(page, `run-sent-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      // Meanwhile the owner takes Omar's number away: his card says why, and Skip is the way on.
      const cur = (await callApi<{ lead: { version: number } }>(o.page, "GET", `/api/v1/leads/${ids[1]}`))
        .data.lead;
      await callApi(
        o.page,
        "PATCH",
        `/api/v1/leads/${ids[1]}`,
        { phone: null },
        { "if-match": String(cur.version) },
      );
      await o.close();
      await run.getByRole("button", { name: "Yes, sent" }).click();
      await expect(run.getByRole("heading", { name: `Shot Omar ${theme}` })).toBeVisible();
      await expect(run.getByText("No WhatsApp number")).toBeVisible();
      await expect(run.getByRole("button", { name: "Send" })).toHaveCount(0);
      await settle(page);
      await reviewCopy(page, `run-skip-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await run.getByRole("button", { name: "Skip" }).click();

      const summary = run.getByRole("region", { name: "Run finished" });
      await expect(summary).toContainText("1 sent");
      await settle(page);
      await reviewCopy(page, `run-summary-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await summary.getByRole("button", { name: "Done" }).click();
      await page.waitForURL(/\/today$/);
    }
  });
});
