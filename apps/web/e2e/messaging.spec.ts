import AxeBuilder from "@axe-core/playwright";
import type { BrowserContext, Page } from "@playwright/test";
import {
  PEOPLE,
  callApi,
  expect,
  freezeVolatile,
  nearBusinessMidnight,
  openApp,
  reviewCopy,
  stateFile,
  test,
} from "./fixtures";
import { settle } from "./settle";

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
const volatile = (page: Page) => [page.locator("[data-volatile]")];

/** WhatsApp itself is never contacted from a test run: its pages answer with a stub. */
const stubWhatsApp = (context: BrowserContext) =>
  context.route(/^https:\/\/(wa\.me|api\.whatsapp\.com)\//, (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp</title>" }),
  );
/** Open WhatsApp: a real new tab (no popup blocker tripped), pointed at wa.me, closed again; back to LUME. */
async function handOff(page: Page, context: BrowserContext, number: string) {
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Open WhatsApp" }).click(),
  ]);
  await tab.waitForURL(new RegExp(`^https://wa\\.me/${number}`));
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.close();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

const made: string[] = [];
/** A lead of Noor's (Sales, masked), made by the owner. */
async function noorsLead(page: Page, name: string, phone: string): Promise<string> {
  const people = (await callApi<{ people: { id: string; name: string }[] }>(page, "GET", "/api/v1/people"))
    .data.people;
  const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", {
    name,
    phone,
    ownerId: people.find((p) => p.name === PEOPLE.seller.name)!.id,
  });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  made.push(r.data.lead.id);
  return r.data.lead.id;
}

test.describe("Templates and sending (4A)", () => {
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await page.goto("/leads");
    if (made.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    const list = await callApi<{ templates: { id: string; name: string }[] }>(
      page,
      "GET",
      "/api/v1/templates",
    );
    for (const t of list.data.templates.filter((x) => x.name === "Struggles check"))
      await callApi(page, "POST", `/api/v1/templates/${t.id}/archive`);
    await ctx.close();
  });

  test("a manager writes a template with one of the business's own fields, and sees it as WhatsApp will", async ({
    page,
  }) => {
    await openApp(page, "/templates");
    // A fresh install starts with the starters, by kind.
    await expect(page.getByRole("list", { name: "First touch" })).toContainText("First hello");
    await expect(page.getByRole("list", { name: "Follow-up" })).toContainText("Gentle nudge");
    await page.getByRole("button", { name: "New template" }).click();
    await expect(page.getByRole("dialog", { name: "New template" })).toBeVisible();
    const editor = page.getByRole("dialog"); // it takes the template's name once saved
    await editor.getByRole("textbox", { name: "Name" }).fill("Struggles check");
    await editor.getByRole("radio", { name: "Follow-up" }).click();
    await editor
      .getByRole("textbox", { name: "Message" })
      .fill("Hi {{lead.first_name}}, still thinking about *{{lead.custom.struggles}}*?");
    const preview = editor.getByRole("figure", { name: "Preview" });
    await expect(preview).toContainText("Hi Alex, still thinking about");
    await expect(preview.locator("mark[data-missing]")).toHaveText("{{lead.custom.struggles}}");
    await editor.getByRole("button", { name: "Save" }).click();
    // Saved (owner, 2026-10-05): LUME reads it back, the editor closes, and a Saved says so.
    await expect(page.getByRole("status").filter({ hasText: "“Struggles check” saved" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Follow-up" })).toContainText("Struggles check");
  });

  test.describe("a masked rep", () => {
    test.use({ storageState: stateFile("seller") });

    test("sends a template from the drawer, confirms it, and logs the reply — each moves the lead on", async ({
      page,
      context,
      browser,
    }) => {
      const owner = await browser.newContext({ storageState: stateFile("owner") });
      const op = await owner.newPage();
      await openApp(op, "/leads");
      const id = await noorsLead(op, "Mira Solen", "+971509990011");
      await owner.close();

      await stubWhatsApp(context);
      await openApp(page, `/leads?lead=${id}`);
      const drawer = page.getByRole("dialog", { name: "Mira Solen" });
      await drawer.getByRole("button", { name: "WhatsApp" }).click();
      const sheet = page.getByRole("dialog", { name: "WhatsApp Mira Solen" });
      await sheet.getByRole("option", { name: /Gentle nudge/ }).click();
      await expect(sheet.getByRole("textbox", { name: "Message" })).toHaveValue(
        /^Hi Mira, just checking in on my last message\./,
      );
      await handOff(page, context, "971509990011");
      await expect(page.locator("body")).not.toContainText("wa.me");
      await expect(page.locator("body")).not.toContainText("9990011");
      await expect(page.locator("body")).not.toContainText("999 0011");

      await drawer.getByRole("button", { name: "Yes, sent" }).click();
      await expect(drawer.getByRole("status")).toContainText("Moved to Message sent");

      await drawer.getByRole("button", { name: "They replied" }).click();
      await expect(page.getByText("They replied · Moved to Replied")).toBeVisible();

      await drawer.getByRole("tab", { name: "History" }).click();
      const history = drawer.getByRole("tabpanel");
      await expect(history.getByText("from “Gentle nudge”", { exact: false })).toBeVisible();
      await expect(history.getByText("They replied", { exact: true })).toBeVisible();
      await expect(history.getByText("Moved to Replied", { exact: true })).toBeVisible();
    });

    test("WhatsApp from a Today follow-up completes it", async ({ page, context, browser }) => {
      test.skip(nearBusinessMidnight(), "in the business's last hour, a follow-up in 1 hour is tomorrow's");
      const owner = await browser.newContext({ storageState: stateFile("owner") });
      const op = await owner.newPage();
      await openApp(op, "/leads");
      const id = await noorsLead(op, "Teo Varga", "+971509990022");
      await owner.close();

      await openApp(page, "/leads");
      await callApi(page, "POST", `/api/v1/leads/${id}/tasks`, {
        title: "Nudge Teo",
        due: { preset: "in_1h" },
      });
      await stubWhatsApp(context);
      await openApp(page, "/today");
      const soon = page.getByRole("list", { name: "Due soon" });
      await soon.getByRole("button", { name: "WhatsApp Teo Varga" }).click();
      const sheet = page.getByRole("dialog", { name: "WhatsApp Teo Varga" });
      // A follow-up suggests Follow-up first.
      await expect(sheet.getByRole("option").first()).toHaveAttribute("data-name", "Gentle nudge");
      await sheet.getByRole("option", { name: /Gentle nudge/ }).click();
      await handOff(page, context, "971509990022");
      await page.getByRole("button", { name: "Yes, sent" }).click();
      await expect(page.getByRole("link", { name: "Teo Varga" })).toBeHidden({ timeout: 10_000 });
    });
  });

  test("Reopen a lost lead into an open stage", async ({ page }) => {
    await openApp(page, "/leads");
    const id = await noorsLead(page, "Ines Brand", "+971509990033");
    const { pipelines } = (
      await callApi<{ pipelines: { stages: { id: string; kind: string }[] }[] }>(
        page,
        "GET",
        "/api/v1/pipelines",
      )
    ).data;
    const lost = pipelines[0]!.stages.find((s) => s.kind === "lost")!;
    const reasons = (await callApi<{ lostReasons: { id: string }[] }>(page, "GET", "/api/v1/lost-reasons"))
      .data.lostReasons;
    const r = await callApi(page, "POST", `/api/v1/leads/${id}/stage`, {
      stageId: lost.id,
      lostReasonId: reasons[0]!.id,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Ines Brand" });
    await expect(drawer.getByRole("button", { name: "They replied" })).toHaveCount(0);
    await drawer.getByRole("button", { name: "Reopen" }).click();
    await expect(page.getByRole("menuitem").first()).toHaveText("New");
    await page.getByRole("menuitem", { name: "New", exact: true }).click();
    await expect(page.getByText("Reopened into New")).toBeVisible();
    await drawer.getByRole("tab", { name: "History" }).click();
    const history = drawer.getByRole("tabpanel");
    await expect(history.getByText("Reopened", { exact: true })).toBeVisible();
    await expect(history.getByText(/^into New/)).toBeVisible();
  });

  test("screenshots and axe: the library, the editor, the send sheet, the Sent prompt and the drawer — both themes", async ({
    page,
    context,
  }) => {
    await openApp(page, "/leads");
    const id = await noorsLead(page, "Shot Messaging", "+971509990044");
    await stubWhatsApp(context);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/templates");
      await expect(page.getByRole("list", { name: "First touch" })).toBeVisible();
      await reviewCopy(page.locator("main"), `templates-${theme}.png`);
      await expect(page.locator("main")).toHaveScreenshot(`templates-${theme}.png`);
      expect(await axe(page)).toEqual([]);

      await page.getByRole("button", { name: /^First hello/ }).click();
      const editor = page.getByRole("dialog", { name: "First hello" });
      await expect(editor.getByRole("figure", { name: "Preview" })).toContainText("Hi Alex");
      await reviewCopy(editor, `template-editor-${theme}.png`);
      await expect(editor).toHaveScreenshot(`template-editor-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden();

      await openApp(page, `/leads?lead=${id}`);
      const drawer = page.getByRole("dialog", { name: "Shot Messaging" });
      await expect(drawer.getByRole("button", { name: "They replied" })).toBeVisible();
      await settle(page);
      await reviewCopy(drawer, `drawer-send-actions-${theme}.png`);

      await drawer.getByRole("button", { name: "WhatsApp" }).click();
      const sheet = page.getByRole("dialog", { name: "WhatsApp Shot Messaging" });
      await sheet.getByRole("option", { name: /First hello/ }).click();
      await reviewCopy(sheet, `send-sheet-${theme}.png`);
      await expect(sheet).toHaveScreenshot(`send-sheet-${theme}.png`);
      expect(await axe(page)).toEqual([]);

      await handOff(page, context, "971509990044");
      const prompt = drawer.getByRole("group", { name: "Was the WhatsApp message sent?" });
      await expect(prompt).toBeVisible();
      await settle(page);
      await reviewCopy(drawer, `sent-prompt-${theme}.png`);
      await expect(prompt).toHaveScreenshot(`sent-prompt-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await prompt.getByRole("button", { name: "Not sent" }).click();
      await expect(prompt).toBeHidden();
      // The compared copy last: it fixes run-to-run times to one size (the review copies above show them).
      await freezeVolatile(page);
      await expect(drawer).toHaveScreenshot(`drawer-send-actions-${theme}.png`, { mask: volatile(page) });
    }
  });
});
