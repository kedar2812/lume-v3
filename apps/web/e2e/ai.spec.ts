import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { callApi, expect, freezeVolatile, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * LUME AI in the lead drawer (spec 2026-10-18 §5.2–5.3), against the fake provider (LUME_AI_PROVIDER=fake: the next
 * open stage and tomorrow at 11:00, or three plain catch-up lines). Never a real model.
 */
async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
const made: string[] = [];
async function lead(page: Page, name: string): Promise<string> {
  const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", { name });
  made.push(r.data.lead.id);
  return r.data.lead.id;
}
const switchAi = async (page: Page, enabled: boolean) => {
  const r = await callApi(page, "PUT", "/api/v1/integrations/ai", { enabled });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
};
const volatile = (page: Page) => [
  page.locator("[data-volatile]"),
  page.getByRole("button", { name: /^Notifications/ }),
];

test.describe("LUME AI in the drawer", () => {
  test.use({ storageState: stateFile("owner") });

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/leads");
    await switchAi(page, true);
    await ctx.close();
  });
  // Leave the workspace as it was: LUME AI off (its default), and these leads gone.
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/leads");
    await switchAi(page, false);
    if (made.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    await ctx.close();
  });

  test("a call with a note: a suggested next step, applied in one tap — the stage and the follow-up are on the lead", async ({
    page,
  }) => {
    await openApp(page, "/leads");
    const id = await lead(page, "Sneha Reddy");
    const before = (await callApi<{ lead: { stageId: string } }>(page, "GET", `/api/v1/leads/${id}`)).data
      .lead;
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Sneha Reddy" });
    await drawer.getByRole("button", { name: "Log a call (C)" }).click();
    const log = page.getByRole("dialog", { name: "Log a call" });
    await log.getByRole("textbox").fill("Wants a site visit on Saturday. Her husband decides on the budget.");
    await log.getByRole("button", { name: "Log call" }).click();

    const card = drawer.getByRole("region", { name: "Suggested next step" });
    await expect(card.getByRole("heading", { name: "Suggested next step" })).toBeFocused();
    await expect(card).toContainText("Interested, and wants to meet.");
    const stage = card.getByRole("checkbox", { name: /^Move to / });
    const followUp = card.getByRole("checkbox", { name: /^Follow up .* Call back$/ });
    await expect(stage).toBeChecked();
    await expect(followUp).toBeChecked();
    await reviewCopy(card, "next-step-ready.png");

    await card.getByRole("button", { name: "Apply" }).click();
    const done = drawer.getByRole("region", { name: "Done" });
    await expect(done.getByRole("heading", { name: "Done" })).toBeFocused();
    await expect(done).toContainText(/^Done.*Moved to .+ and set a follow-up for .+ at 11 am\./);
    await reviewCopy(done, "next-step-done.png");

    // On the lead itself: the stage moved, and the follow-up is the next one.
    const after = (await callApi<{ lead: { stageId: string } }>(page, "GET", `/api/v1/leads/${id}`)).data
      .lead;
    expect(after.stageId).not.toBe(before.stageId);
    await expect(drawer.getByRole("region", { name: "Next follow-up" })).toContainText("Call back");
    // Done: no suggestion waits on this lead any more.
    const ai = await callApi<{ pending: unknown }>(page, "GET", `/api/v1/leads/${id}/ai`);
    expect(ai.data.pending).toBeNull();
  });

  test("screenshots and axe: a waiting suggestion, Catch me up offered and read — both themes", async ({
    page,
  }) => {
    await openApp(page, "/leads");
    // A suggestion waiting from an earlier call.
    const a = await lead(page, "Karan Mehta");
    const call = await callApi<{ activity: { id: string } }>(page, "POST", `/api/v1/leads/${a}/calls`, {
      outcome: "talked",
      note: "Liked the quote. Call back tomorrow.",
    });
    const read = await callApi(page, "POST", `/api/v1/leads/${a}/ai/next-step`, {
      activityId: call.data.activity.id,
    });
    expect(read.status, JSON.stringify(read.data)).toBe(200);
    // A lead just handed to me: Catch me up is offered.
    const b = await lead(page, "Karthik Varma");
    const { data: me } = await callApi<{ user: { id: string } }>(page, "GET", "/api/v1/auth/me");
    const people = (await callApi<{ people: { id: string }[] }>(page, "GET", "/api/v1/people")).data.people;
    const other = people.find((p) => p.id !== me.user.id)!;
    await callApi(page, "POST", `/api/v1/leads/${b}/assign`, { ownerId: other.id });
    await callApi(page, "POST", `/api/v1/leads/${b}/assign`, { ownerId: me.user.id });

    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, `/leads?lead=${a}`);
      const drawer = page.getByRole("dialog", { name: "Karan Mehta" });
      const card = drawer.getByRole("region", { name: "Suggested next step" });
      await expect(card.getByRole("checkbox", { name: /^Move to / })).toBeVisible();
      await reviewCopy(drawer, `drawer-next-step-${theme}.png`);
      await freezeVolatile(page);
      await expect(card).toHaveScreenshot(`next-step-${theme}.png`, { mask: volatile(page) });
      expect(await axe(page)).toEqual([]);

      await openApp(page, `/leads?lead=${b}`);
      const drawerB = page.getByRole("dialog", { name: "Karthik Varma" });
      const offer = drawerB.getByRole("button", { name: "Catch me up" });
      await expect(offer).toBeVisible();
      await reviewCopy(drawerB, `drawer-catch-up-offered-${theme}.png`);
      await offer.click();
      const lines = drawerB.getByRole("region", { name: "Catch-up" });
      await expect(lines.getByRole("listitem")).toHaveCount(3);
      await expect(lines.getByRole("heading", { name: "Catch-up" })).toBeFocused();
      await reviewCopy(drawerB, `drawer-catch-up-${theme}.png`);
      await expect(lines).toHaveScreenshot(`catch-up-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
  });
});
