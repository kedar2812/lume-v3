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
  });
});
