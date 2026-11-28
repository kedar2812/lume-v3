import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { callApi, expect, openApp, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * The flow builder end to end (plan 2026-11-23-flow-builder, Task B1): a flow opens on its canvas with Starts when and
 * its steps; a step added from the rail is saved and still there after a reload; at every width, in both themes,
 * nothing runs off the side (owner 2026-11-23: "dont overflow the contents"); and it's accessible as drawn.
 */
test.use({ storageState: stateFile("owner") });

const LONG =
  "Hi! Thanks for commenting. Here is the guide you asked for, with every recipe, the shopping list and a week of plans laid out day by day so nothing is missed.";

/** A flow with a long name and long words in its steps, made through the API. */
async function makeFlow(page: Page): Promise<string> {
  const on = await callApi(page, "PUT", "/api/v1/integrations/instagram", { enabled: true });
  expect(on.status, JSON.stringify(on.data)).toBeLessThan(300);
  const f = await callApi<{ id: string; rev: number }>(page, "POST", "/api/v1/instagram/flows", {
    name: "A lead magnet with a rather long name that has to stay on one line in the top bar",
  });
  expect(f.status, JSON.stringify(f.data)).toBe(201);
  const graph = {
    v: 2,
    start: "hi",
    nodes: [
      {
        id: "hi",
        type: "message",
        text: LONG,
        buttons: [],
        replies: [
          { id: "y", title: "Yes, send it to me", next: "q" },
          { id: "n", title: "Not right now", next: null },
        ],
        next: null,
      },
      {
        id: "q",
        type: "ask",
        text: "Where should LUME send it?",
        save: { field: "email", kind: "email" },
        retry: "That doesn't look like an email.",
        next: null,
        noAnswer: { afterMinutes: 60, next: null },
      },
    ],
    pos: { _start: { x: -300, y: 0 }, hi: { x: 0, y: 0 }, q: { x: 320, y: 0 } },
    notes: [],
  };
  const s = await callApi(page, "PUT", `/api/v1/instagram/flows/${f.data.id}`, { rev: f.data.rev, graph });
  expect(s.status, JSON.stringify(s.data)).toBe(200);
  return f.data.id;
}

/** Nothing wider than the window, and no card's words pushing past its box. */
async function noOverflow(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(wide).toBeLessThanOrEqual(0);
  const spill = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        "[data-full-canvas] header *, [data-full-canvas] aside *, .react-flow__node *",
      ),
    ]
      // Words only: a step's ports sit just outside its card on purpose.
      .filter((el) => [...el.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent!.trim()))
      .filter((el) => {
        const s = getComputedStyle(el);
        if (s.overflowX === "auto" || s.overflowX === "scroll") return false;
        return (
          el.scrollWidth > el.clientWidth + 1 && s.overflowX !== "hidden" && s.textOverflow !== "ellipsis"
        );
      })
      .map((el) => `${el.tagName}.${el.className}`)
      .slice(0, 5),
  );
  expect(spill).toEqual([]);
}

test.describe("The flow builder", () => {
  let id = "";
  test.beforeEach(async ({ page }) => {
    await openApp(page, "/today");
    id = await makeFlow(page);
  });
  // Leave the workspace as it was: Instagram off, the flow archived (later specs' screenshots must not see either).
  test.afterEach(async ({ page }) => {
    await callApi(page, "POST", `/api/v1/instagram/flows/${id}/archive`);
    await callApi(page, "PUT", "/api/v1/integrations/instagram", { enabled: false });
  });

  test("a flow on its canvas; a step added is saved and still there after a reload", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, `/instagram/flows/${id}`);
    await expect(page.getByLabel("Starts when")).toBeVisible();
    await expect(page.getByLabel(/^Step: Message/)).toContainText("Yes, send it to me");
    await expect(page.getByLabel(/^Step: Ask/)).toBeVisible();
    await page.getByRole("button", { name: "Add Wait" }).click();
    await expect(page.getByLabel(/^Step: Wait/)).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await expect(page.getByLabel(/^Step: Wait/)).toBeVisible();
    // The step's panel: its words changed there change the card, and are saved.
    await page.getByLabel(/^Step: Ask/).click();
    const panel = page.getByRole("complementary", { name: "Ask step" });
    await panel.getByRole("textbox", { name: /Question/ }).fill("Which email should LUME use?");
    await expect(page.getByLabel("Step: Ask, Which email should LUME use?")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await expect(page.getByLabel("Step: Ask, Which email should LUME use?")).toBeVisible();
    // Starts when: a way in with its keyword, saved, on the card.
    await page.getByLabel("Starts when").first().click();
    const start = page.getByRole("complementary", { name: "Starts when" });
    await start.getByRole("button", { name: "+ Add a way in" }).click();
    await start.getByRole("textbox", { name: /Keywords/ }).fill("guide");
    await start.getByRole("button", { name: "Save" }).click();
    await expect(start.getByRole("status")).toHaveText("Saved.");
    await expect(page.getByRole("group", { name: "Starts when" })).toContainText("Comments on a post");
    // A way in the server already has (it comes with its id) changes and saves again (review 2026-11-24).
    await page.reload();
    await page.getByLabel("Starts when").first().click();
    await start.getByRole("textbox", { name: /Keywords/ }).fill("guide, free");
    await start.getByRole("button", { name: "Save" }).click();
    await expect(start.getByRole("status")).toHaveText("Saved.");
    await expect(start.getByRole("button", { name: "Save" })).toBeDisabled();
    await page.reload();
    await expect(page.getByRole("group", { name: "Starts when" })).toContainText("guide +1");
  });

  // Owner 2026-11-28: "the cards are laggy". React Flow measured every card again on every frame of a drag (each
  // handed over as a new object without its size), so every card was hidden and measured, and every line redrawn.
  test("dragging a card moves only it: no other card is measured again, no line rebuilt", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, `/instagram/flows/${id}`);
    const ask = page.getByLabel(/^Step: Ask/);
    await expect(ask).toBeVisible();
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const w = window as unknown as { __m: string[]; __o: MutationObserver };
      w.__m = [];
      w.__o = new MutationObserver((ms) => {
        for (const m of ms) {
          const el = m.target as HTMLElement;
          if (
            m.type === "attributes" &&
            el.classList.contains("react-flow__node") &&
            !el.querySelector("[aria-label^='Step: Ask']")
          )
            w.__m.push(`card ${el.dataset.id} ${m.attributeName}`);
          if (m.type === "childList" && el.classList.contains("react-flow__edges"))
            w.__m.push("lines rebuilt");
          // The dragged card itself is never hidden to be measured again (it flickered with every move).
          if (
            m.type === "attributes" &&
            el.classList.contains("react-flow__node") &&
            el.querySelector("[aria-label^='Step: Ask']") &&
            el.style.visibility === "hidden"
          )
            w.__m.push("dragged card hidden");
        }
      });
      w.__o.observe(document.body, { subtree: true, attributes: true, childList: true });
    });
    const box = (await ask.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 20);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + box.width / 2 + i * 6, box.y + 20 + i * 3);
    await page.mouse.up();
    const seen = await page.evaluate(() => (window as unknown as { __m: string[] }).__m);
    expect(seen).toEqual([]);
    // No page text is selected by dragging a card or panning the canvas.
    // On the bare canvas, its step's panel closed (the panels' own words stay selectable).
    await page.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByRole("complementary", { name: "Ask step" })).toBeHidden();
    const canvas = (await page.getByRole("region", { name: "The flow's canvas" }).boundingBox())!;
    const px = canvas.x + canvas.width - 120;
    const py = canvas.y + 60;
    await page.mouse.move(px, py);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(px - i * 30, py + i * 15);
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
    await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 10_000 });
  });

  test("Test: the flow on an iPhone as Instagram shows it; nothing is sent", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, `/instagram/flows/${id}`);
    await expect(page.getByLabel(/^Step: Message/)).toBeVisible();
    await page.getByRole("button", { name: "Test", exact: true }).click();
    const phone = page.getByLabel("The flow as it reads on Instagram");
    await expect(phone).toBeVisible();
    const log = phone.getByRole("log");
    await expect(log).toContainText("Here is the guide you asked for");
    await phone.getByRole("button", { name: "Yes, send it to me" }).click();
    await expect(log).toContainText("Where should LUME send it?");
    await expect(page.getByLabel(/^Step: Ask/)).toHaveAttribute("data-lit", "true");
    const write = phone.getByRole("textbox", { name: "Write as the person" });
    await write.fill("not an email");
    await write.press("Enter");
    await expect(log).toContainText("That doesn't look like an email.");
    await write.fill("sam@example.test");
    await write.press("Enter");
    await expect(log).toContainText("Saves sam@example.test as email");
    await expect(page.getByRole("status").filter({ hasText: "The flow has ended." })).toBeVisible();
    // A test changes nothing: the flow is as it was saved.
    const f = await callApi<{ rev: number }>(page, "GET", `/api/v1/instagram/flows/${id}`);
    expect(f.data.rev).toBe(2);
    await page.getByRole("button", { name: "Play again" }).click();
    await expect(log).not.toContainText("Where should LUME send it?");
    // The same panel's other two: Replay (nobody yet, it's a draft) and Versions (nothing live yet).
    await page.getByRole("radio", { name: "Replay" }).click();
    await expect(page.getByRole("complementary", { name: "Replay" })).toContainText(
      "Nobody has been through this flow yet",
    );
    await page.getByRole("radio", { name: "Versions" }).click();
    await expect(page.getByRole("complementary", { name: "Versions" })).toContainText(
      "Nothing has gone live yet",
    );
  });

  test("Numbers: every step's last 30 days, on its card", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, `/instagram/flows/${id}`);
    await page.getByRole("radio", { name: "Numbers" }).click();
    await expect(page.getByText("Last 30 days")).toBeVisible();
    await expect(page.getByLabel(/^Step: Message/)).toContainText("Entered0");
    await page.getByRole("radio", { name: "Build" }).click();
    await expect(page.getByLabel(/^Step: Message/)).not.toContainText("Entered");
  });

  for (const theme of ["light", "dark"] as const)
    test(`nothing runs off the side at any width (${theme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [900, 1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await openApp(page, `/instagram/flows/${id}`);
        await expect(page.getByLabel(/^Step: Message/)).toBeVisible();
        await settle(page);
        await noOverflow(page);
        // With a step's panel open, the long words in it too.
        await page.getByLabel(/^Step: Message/).click();
        await expect(page.getByRole("complementary", { name: "Message step" })).toBeVisible();
        await noOverflow(page);
        // With the phone test open, a reply tapped and long words in the chat.
        await page.getByRole("button", { name: "Test", exact: true }).click();
        const phone = page.getByLabel("The flow as it reads on Instagram");
        await phone.getByRole("button", { name: "Yes, send it to me" }).click();
        await expect(phone.getByRole("log")).toContainText("Where should LUME send it?");
        await noOverflow(page);
        const box = await phone.boundingBox();
        expect(box!.y + box!.height).toBeLessThanOrEqual(900);
        // Numbers on, with Versions open: the top bar's extra controls still fit.
        await page.getByRole("radio", { name: "Numbers" }).click();
        await page.getByRole("radio", { name: "Versions" }).click();
        await expect(page.getByRole("complementary", { name: "Versions" })).toBeVisible();
        await noOverflow(page);
        // The top bar holds everything, Publish whole inside it (its own overflow is hidden, so look at the edges).
        const bar = await page.locator("[data-full-canvas] header").boundingBox();
        const pub = await page.getByRole("button", { name: /^Publish/ }).boundingBox();
        expect(pub!.x + pub!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 0.5);
        // A custom range, the longest label it has: Publish still whole, and the calendar inside the window.
        await page.getByRole("button", { name: /Last 30 days/ }).click();
        const cal = page.getByRole("dialog", { name: "Date range" });
        await cal.getByRole("button", { name: "The month before" }).click();
        const days = cal.getByRole("grid").getByRole("button");
        await days.nth(8).click();
        const pop = await cal.boundingBox();
        expect(pop!.x).toBeGreaterThanOrEqual(0);
        expect(pop!.x + pop!.width).toBeLessThanOrEqual(width);
        await cal.getByRole("grid").getByRole("button").nth(20).click();
        await expect(cal).toBeHidden();
        const pub2 = await page.getByRole("button", { name: /^Publish/ }).boundingBox();
        expect(pub2!.x + pub2!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 0.5);
        await noOverflow(page);
      }
      // A phone: the canvas needs a wider screen, and says so, without running off the side.
      await page.setViewportSize({ width: 375, height: 800 });
      await openApp(page, `/instagram/flows/${id}`);
      await expect(page.getByText("The builder needs a wider screen.")).toBeVisible();
      await noOverflow(page);
    });

  test("accessible as drawn", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page, `/instagram/flows/${id}`);
    await expect(page.getByLabel(/^Step: Message/)).toBeVisible();
    await settle(page);
    const r = await new AxeBuilder({ page })
      .include("[data-full-canvas]")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
    // The phone test too: a reply tapped (a bubble on each side) and words typed (Send shows).
    await page.getByRole("button", { name: "Test", exact: true }).click();
    const phone = page.getByLabel("The flow as it reads on Instagram");
    await phone.getByRole("button", { name: "Yes, send it to me" }).click();
    await phone.getByRole("textbox", { name: "Write as the person" }).fill("sam@");
    await settle(page);
    const t = await new AxeBuilder({ page })
      .include("[data-full-canvas]")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(t.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
  });
});
