import { createHmac } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { Browser, Page } from "@playwright/test";
import { alertIn, callApi, expect, hydrated, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * Instagram in Settings → Integrations (plan 2026-11-25-instagram-screens D1), end to end: the real relay
 * (e2e/relay.ts) signs in against its fake Instagram, hands the account back to LUME, and the card shows it.
 */
const RELAY = "http://127.0.0.1:3115";
const IG = "http://127.0.0.1:3117";
const IG_SECRET = "ig-app-secret-for-tests";
const ACCOUNT = "17841400000000001";
const made: string[] = [];
const flows: string[] = [];

/** A DM as Instagram delivers it to the relay, signed with the app's secret. */
async function dm(page: Page, o: { from: string; mid: string; text: string }) {
  const raw = Buffer.from(
    JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: Date.now(),
          messaging: [
            {
              sender: { id: o.from },
              recipient: { id: ACCOUNT },
              timestamp: Date.now(),
              message: { mid: o.mid, text: o.text },
            },
          ],
        },
      ],
    }),
  );
  const r = await page.request.post(`${RELAY}/ig/in`, {
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", IG_SECRET).update(raw).digest("hex")}`,
    },
    data: raw,
  });
  expect(r.status()).toBe(200);
}
async function accountOf(page: Page) {
  const a = await callApi<{ accounts: { id: string; sourceId: string }[] }>(
    page,
    "GET",
    "/api/v1/instagram/accounts",
  );
  return a.data.accounts[0]!;
}

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
async function themed(browser: Browser, theme: "light" | "dark", width = 1440) {
  const ctx = await browser.newContext({
    storageState: stateFile("owner"),
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width, height: 900 },
  });
  const page = await ctx.newPage();
  await openApp(page, "/settings/integrations");
  await hydrated(page);
  return { ctx, page };
}
const cardOf = (page: Page) => page.getByRole("article", { name: /^Instagram/ });
/** Nothing on the page is wider than the window (owner: no overflow). */
async function fits(page: Page) {
  const w = await page.evaluate(() => document.documentElement.clientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
}
async function connectThroughInstagram(page: Page) {
  const card = cardOf(page);
  await card.getByRole("button", { name: /^Connect (an Instagram account|another account)$/ }).click();
  const sheet = page.getByRole("dialog", { name: "Connect an Instagram account" });
  await sheet.getByRole("button", { name: /Continue to Instagram/ }).click();
  // The relay, the fake Instagram's sign-in (it says yes at once), the relay again, then LUME's hand-back page.
  await page.waitForURL("**/settings/integrations#instagram", { timeout: 30_000 });
}

test.describe("Instagram in Settings → Integrations (D1)", () => {
  test.describe.configure({ mode: "serial" });

  test.afterAll(async ({ browser }) => {
    // Leave the workspace as it was: no account, Instagram off (later specs' screenshots must not see either).
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/settings/integrations");
    const list = await callApi<{ accounts: { id: string }[] }>(page, "GET", "/api/v1/instagram/accounts");
    for (const id of flows) await callApi(page, "POST", `/api/v1/instagram/flows/${id}/archive`);
    if (made.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    for (const a of list.data.accounts ?? [])
      await callApi(page, "DELETE", `/api/v1/instagram/accounts/${a.id}`);
    await callApi(page, "PUT", "/api/v1/integrations/instagram", { enabled: false });
    await page.request.post(`${IG}/__fake/ig`, { data: {} });
    await ctx.close();
  });

  test("off, then on: what it does, and what connecting will do before anything happens", async ({
    browser,
  }) => {
    const { ctx, page } = await themed(browser, "light");
    const card = cardOf(page);
    await expect(card.getByRole("switch", { name: "Instagram" })).not.toBeChecked();
    await expect(card).toContainText("Not connected yet");
    await card.getByRole("switch", { name: "Instagram" }).click();
    await expect(card).toContainText("Turn Instagram comments and DMs into leads");
    expect(await axe(page)).toEqual([]);
    await card.getByRole("button", { name: "Connect an Instagram account" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect an Instagram account" });
    await expect(sheet).toContainText("It must be a professional account (Business or Creator).");
    expect(await axe(page)).toEqual([]);
    await reviewCopy(page, "instagram-connect-sheet.png");
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
    await ctx.close();
  });

  test("connecting goes through Instagram and comes back connected, once", async ({ browser }) => {
    const { ctx, page } = await themed(browser, "light");
    let handBack = "";
    page.on("request", (r) => {
      if (r.isNavigationRequest() && /\/instagram\/connected\?p=/.test(r.url())) handBack = r.url();
    });
    await connectThroughInstagram(page);
    await expect(page.getByText("Instagram connected")).toBeVisible();
    // The address no longer holds the hand-back.
    expect(page.url()).not.toContain("p=");
    const card = cardOf(page);
    const list = card.getByRole("list", { name: "Connected accounts" });
    await expect(list).toContainText("@harbour.studio");
    await expect(card).toContainText("1 account connected");
    // The hand-back is single use: opened again (a refresh, a second tab), it says so and nothing more connects.
    expect(handBack).not.toBe("");
    await page.goto(handBack);
    await expect(alertIn(page)).toContainText("already used");
    await openApp(page, "/settings/integrations");
    await expect(cardOf(page)).toContainText("1 account connected");
    await ctx.close();
  });

  test("whose account and what happens to new people: kept after a reload", async ({ browser }) => {
    const { ctx, page } = await themed(browser, "light");
    const card = cardOf(page);
    const whose = card.getByRole("combobox", { name: "Whose account is @harbour.studio?" });
    await whose.selectOption({ label: "The business" });
    await card.getByRole("radio", { name: "Wait in Not a lead yet" }).click();
    await expect(card).toContainText("They wait in Not a lead yet for 14 days");
    await page.reload();
    await hydrated(page);
    await expect(cardOf(page).getByRole("radio", { name: "Wait in Not a lead yet" })).toBeChecked();
    await cardOf(page).getByRole("radio", { name: "Become leads" }).click();
    await expect(cardOf(page).getByRole("radio", { name: "Become leads" })).toBeChecked();
    await ctx.close();
  });

  for (const theme of ["light", "dark"] as const)
    for (const width of [375, 768, 1280, 1440])
      test(`connected, ${theme}, ${width} px: nothing overflows and axe finds nothing`, async ({
        browser,
      }) => {
        const { ctx, page } = await themed(browser, theme, width);
        await expect(cardOf(page).getByRole("list", { name: "Connected accounts" })).toBeVisible();
        await cardOf(page).scrollIntoViewIfNeeded();
        await fits(page);
        expect(await axe(page)).toEqual([]);
        if (width === 1440 || width === 375)
          await reviewCopy(cardOf(page), `instagram-card-${theme}-${width}.png`);
        await ctx.close();
      });

  test("a cancelled sign-in says so on the relay's page, with the way back to LUME", async ({ browser }) => {
    const { ctx, page } = await themed(browser, "light");
    await page.request.post(`${IG}/__fake/ig`, { data: { cancel: true } });
    await cardOf(page).getByRole("button", { name: "Connect another account" }).click();
    await page
      .getByRole("dialog", { name: "Connect an Instagram account" })
      .getByRole("button", { name: /Continue to Instagram/ })
      .click();
    await page.waitForURL(`${RELAY}/ig/callback**`);
    await expect(page.locator("body")).toContainText("the sign-in was cancelled");
    await page.request.post(`${IG}/__fake/ig`, { data: {} });
    await ctx.close();
  });

  test("a personal account is refused with how to switch it", async ({ browser }) => {
    const { ctx, page } = await themed(browser, "light");
    await page.request.post(`${IG}/__fake/ig`, {
      data: { accountType: "PERSONAL", username: "sana.cooks", userId: "17841400000000002" },
    });
    await cardOf(page).getByRole("button", { name: "Connect another account" }).click();
    await page
      .getByRole("dialog", { name: "Connect an Instagram account" })
      .getByRole("button", { name: /Continue to Instagram/ })
      .click();
    await page.waitForURL(`${RELAY}/ig/callback**`);
    await expect(page.locator("body")).toContainText("professional account");
    await page.request.post(`${IG}/__fake/ig`, { data: {} });
    await ctx.close();
  });

  test("the hand-back page on its own says where connecting starts", async ({ browser }) => {
    const { ctx, page } = await themed(browser, "light");
    await openApp(page, "/settings/integrations/instagram/connected");
    await expect(alertIn(page)).toContainText("Start from Settings → Integrations → Instagram");
    // The page's own back arrow has the same name; this is the one under the words.
    await expect(
      page.getByRole("link", { name: "Back to Integrations" }).filter({ hasText: "Back to Integrations" }),
    ).toHaveAttribute("href", "/settings/integrations#instagram");
    await ctx.close();
  });

  test("someone in Sales is sent to Today from the hand-back page, and asks the server nothing", async ({
    browser,
  }) => {
    // "seller" is the Sales role ("rep" in these specs is a manager who may manage integrations).
    const ctx = await browser.newContext({ storageState: stateFile("seller") });
    const page = await ctx.newPage();
    let asked = false;
    page.on("request", (r) => {
      if (r.url().includes("/api/v1/instagram/connect/complete")) asked = true;
    });
    await page.goto("/settings/integrations/instagram/connected?p=x&s=y");
    await expect(page).toHaveURL(/\/today/);
    expect(asked).toBe(false);
    await ctx.close();
  });

  test("D2: a DM becomes a lead; its Instagram tab shows the conversation, and a reply goes as a person", async ({
    browser,
  }) => {
    const { ctx, page } = await themed(browser, "light");
    await page.request.post(`${IG}/__fake/ig/person`, {
      data: { id: "6512000000000091", name: "Priya Shah", username: "priya.eats" },
    });
    await dm(page, { from: "6512000000000091", mid: "aWdfE2EDM1", text: "Hi, is the course still open?" });
    const { sourceId } = await accountOf(page);
    let id = "";
    await expect(async () => {
      const l = await callApi<{ items: { id: string }[] }>(
        page,
        "GET",
        `/api/v1/leads?source=${sourceId}&limit=10`,
      );
      id = l.data.items[0]?.id ?? "";
      expect(id).not.toBe("");
    }).toPass({ timeout: 30_000 });
    made.push(id);
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Priya Shah", exact: true });
    await drawer.getByRole("tab", { name: "Instagram" }).click();
    const tab = drawer.getByRole("region", { name: "Instagram with Priya Shah" });
    await expect(tab).toContainText("Hi, is the course still open?");
    await expect(tab).toContainText("on @harbour.studio");
    await expect(tab.getByRole("status", { name: "Instagram’s window" })).toContainText(
      /^Open for 2[34] hours/,
    );
    expect(await axe(page)).toEqual([]);
    await reviewCopy(drawer, "instagram-drawer-tab.png");
    const box = tab.getByRole("textbox", { name: "Reply to Priya Shah on Instagram" });
    await box.fill("Yes! The next batch starts Monday.");
    await box.press("Enter");
    await expect(box).toHaveValue("");
    const list = tab.getByRole("list", { name: "Messages" });
    await expect(list).toContainText("Yes! The next batch starts Monday.");
    await expect(list).toContainText(/Sent|Sending/, { timeout: 20_000 });
    await ctx.close();
  });

  test("D2: the drawer's Instagram tab on a phone, in the dark: nothing overflows", async ({ browser }) => {
    const { ctx, page } = await themed(browser, "dark", 375);
    await openApp(page, `/leads?lead=${made[0]}`);
    const drawer = page.getByRole("dialog", { name: "Priya Shah", exact: true });
    await drawer.getByRole("tab", { name: "Instagram" }).click();
    await expect(drawer.getByRole("region", { name: "Instagram with Priya Shah" })).toBeVisible();
    await fits(page);
    expect(await axe(page)).toEqual([]);
    await reviewCopy(drawer, "instagram-drawer-tab-phone-dark.png");
    await ctx.close();
  });

  test("D5: with new people waiting, a DM waits in Not a lead yet, then becomes an enquiry", async ({
    browser,
  }) => {
    const { ctx, page } = await themed(browser, "light");
    const a = await accountOf(page);
    const wait = await callApi(page, "PATCH", `/api/v1/instagram/accounts/${a.id}`, {
      newDmCreatesLead: false,
    });
    expect(wait.status).toBe(200);
    await page.request.post(`${IG}/__fake/ig/person`, {
      data: { id: "6512000000000092", name: "Sana Iyer", username: "sana.cooks" },
    });
    await dm(page, { from: "6512000000000092", mid: "aWdfE2EDM2", text: "Do you do plans for PCOS?" });
    await expect(async () => {
      await openApp(page, "/leads/not-yet");
      await expect(page.getByRole("list", { name: "People who wrote" })).toContainText("Sana Iyer", {
        timeout: 2000,
      });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole("list", { name: "Messages from Sana Iyer" })).toContainText(
      "Do you do plans for PCOS?",
    );
    expect(await axe(page)).toEqual([]);
    await reviewCopy(page, "instagram-not-yet.png");
    await page.getByRole("button", { name: "Make it an enquiry" }).click();
    await page.waitForURL(/\/leads\?lead=/);
    made.push(new URL(page.url()).searchParams.get("lead")!);
    await expect(page.getByRole("dialog", { name: "Sana Iyer", exact: true })).toBeVisible();
    await callApi(page, "PATCH", `/api/v1/instagram/accounts/${a.id}`, { newDmCreatesLead: true });
    await ctx.close();
  });

  test("D3–D4: Flows in the sidebar; a ready-made flow from the New flow sheet opens on the canvas", async ({
    browser,
  }) => {
    const { ctx, page } = await themed(browser, "light");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Flows" }).click();
    await page.waitForURL("**/instagram/flows");
    await expect(page.getByText("No flows yet")).toBeVisible();
    await page.getByRole("button", { name: "New flow" }).first().click();
    const sheet = page.getByRole("dialog", { name: "New flow" });
    await expect(sheet.getByRole("option")).toHaveCount(16);
    expect(await axe(page)).toEqual([]);
    await reviewCopy(page, "instagram-new-flow.png");
    await sheet.getByRole("searchbox", { name: "Search ready-made flows" }).fill("story");
    await sheet.getByRole("option", { name: /Story reply/ }).click();
    await expect(sheet.getByRole("complementary", { name: "Story reply, step by step" })).toContainText(
      "Someone replies to any story",
    );
    await sheet.getByRole("button", { name: "Use this flow" }).click();
    await page.waitForURL(/\/instagram\/flows\/[0-9a-f-]{36}/);
    flows.push(page.url().split("/").at(-1)!);
    await page.getByRole("link", { name: "Flows" }).first().click();
    await page.waitForURL("**/instagram/flows");
    const row = page.getByRole("table", { name: "Every flow" }).getByRole("row", { name: /Story reply/ });
    await expect(row).toContainText("Draft");
    await expect(row).toContainText("Any reply to a story");
    await fits(page);
    expect(await axe(page)).toEqual([]);
    await reviewCopy(page, "instagram-flows.png");
    await ctx.close();
  });

  test("disconnect asks first, then the account is gone and its flows stop", async ({ browser }) => {
    const { ctx, page } = await themed(browser, "light");
    const card = cardOf(page);
    await card.getByRole("button", { name: "Disconnect @harbour.studio" }).click();
    const sure = page.getByRole("dialog", { name: "Disconnect @harbour.studio?" });
    expect(await axe(page)).toEqual([]);
    await sure.getByRole("button", { name: "Disconnect" }).click();
    await expect(card).toContainText("Turn Instagram comments and DMs into leads");
    await ctx.close();
  });
});
