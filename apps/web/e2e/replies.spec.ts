import { createHash, createHmac } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import { inbound } from "../../../packages/core/src/whatsapp/fixtures";
import { callApi, expect, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * WhatsApp W2, end to end (spec 2026-10-18 §4.2, §5.1): leads reply on WhatsApp; LUME AI reads what each reply means
 * (the fake model, by the reply's own words) and it shows under the reply on the lead; a stop marks the lead do not
 * contact at once; Who replied (in the sidebar) groups the replies, and a group's action runs as one bulk run with Undo.
 * Against the fake Meta through the real relay. Everything it makes is put back.
 */
const RELAY = "http://127.0.0.1:3115";
const RELAY_TOKEN = "e2e-relay-token-0123456789-abcdefghij";
const INSTANCE = createHash("sha256").update(RELAY_TOKEN).digest("hex").slice(0, 16);
const APP_SECRET = "meta-app-secret-for-tests";
const LEADS = [
  ["Varsha Kulkarni", "+919876540201"],
  ["Imran Qureshi", "+919876540202"],
  ["Joseph Mathew", "+919876540203"],
  ["Nandini Rao", "+919876540204"],
] as const;

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
async function meta(request: APIRequestContext, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
  const r = await request.post(`${RELAY}/wa/in/${INSTANCE}`, {
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    data: raw,
  });
  expect(r.status()).toBe(200);
}
const writes = (request: APIRequestContext, phone: string, text: string) =>
  meta(
    request,
    inbound({
      from: phone.slice(1),
      id: `wamid.IN${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      type: "text",
      text: { body: text },
    }),
  );

const made: string[] = [];

test.describe.serial("Who replied", () => {
  test.use({ storageState: stateFile("owner") });
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/settings/integrations");
    const card = page.getByRole("article", { name: /^WhatsApp/ });
    await card.getByRole("switch", { name: "WhatsApp" }).click();
    await card.getByRole("button", { name: "Connect a WhatsApp number" }).click();
    await page
      .getByRole("dialog", { name: "Connect a WhatsApp number" })
      .getByRole("button", { name: "Continue with Facebook" })
      .click();
    await page.waitForURL(`${RELAY}/wa/start**`, { waitUntil: "domcontentloaded" });
    const state = await page.locator('input[name="state"]').inputValue();
    const done = await page.request.post(`${RELAY}/wa/done`, {
      form: { state, code: "good-code", waba_id: "102290129340398", phone_number_id: "106540352242922" },
      maxRedirects: 0,
    });
    await page.goto(done.headers().location!);
    await page.waitForURL("**/settings/integrations");
    expect((await callApi(page, "PUT", "/api/v1/integrations/ai", { enabled: true })).status).toBe(200);
    for (const [name, phone] of LEADS) {
      const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", { name, phone });
      expect(r.status).toBe(201);
      made.push(r.data.lead.id);
    }
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/today");
    await callApi(page, "PUT", "/api/v1/integrations/ai", { enabled: false });
    const n = await callApi<{ numbers: { id: string }[] }>(page, "GET", "/api/v1/whatsapp/numbers");
    for (const x of n.data.numbers ?? []) await callApi(page, "DELETE", `/api/v1/whatsapp/numbers/${x.id}`);
    await callApi(page, "PUT", "/api/v1/integrations/whatsapp", { enabled: false });
    if (made.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    // The notices its leads caused (replied, asked not to be messaged), and only those.
    const list = await callApi<{ items: { id: number; title: string }[] }>(
      page,
      "GET",
      "/api/v1/notifications",
    );
    const ours = (list.data.items ?? [])
      .filter((x) => /^(Varsha|Imran|Joseph|Nandini)\b/.test(x.title))
      .map((x) => x.id);
    if (ours.length) {
      await callApi(page, "POST", "/api/v1/notifications/read", { ids: ours });
      const cleared = await callApi<{ cleared: number[] }>(page, "POST", "/api/v1/notifications/clear-read");
      const others = cleared.data.cleared.filter((id) => !ours.includes(id));
      if (others.length)
        await callApi(page, "POST", "/api/v1/notifications/clear-read/undo", { ids: others });
    }
    await ctx.close();
  });

  test("a reply on a lead, and what it means right under it", async ({ page }) => {
    await writes(page.request, LEADS[0][1], "How much does a modular kitchen cost?");
    await openApp(page, `/leads?lead=${made[0]}`);
    const drawer = page.getByRole("dialog", { name: "Varsha Kulkarni" });
    await expect(async () => {
      await drawer.getByRole("tab", { name: "WhatsApp" }).click();
      await expect(drawer.getByRole("group", { name: "What Varsha's reply means" })).toBeVisible({
        timeout: 1500,
      });
    }).toPass({ timeout: 30_000 });
    const meaning = drawer.getByRole("group", { name: "What Varsha's reply means" });
    await expect(meaning).toContainText("Asked the price");
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(drawer, `reply-meaning-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("a stop marks the lead do not contact at once", async ({ page }) => {
    await writes(page.request, LEADS[3][1], "Please stop messaging me");
    // On a page of LUME's, so the API's calls have its address.
    await openApp(page, "/leads");
    await expect
      .poll(
        async () =>
          (await callApi<{ lead: { doNotContact: unknown } }>(page, "GET", `/api/v1/leads/${made[3]}`)).data
            .lead.doNotContact,
        { timeout: 20_000 },
      )
      .not.toBeNull();
  });

  test("Who replied: found in the sidebar, the replies grouped by meaning; a group's action with Undo", async ({
    page,
  }) => {
    await writes(page.request, LEADS[1][1], "Sorry, wrong number");
    await writes(page.request, LEADS[2][1], "Can you call me tomorrow evening?");
    await openApp(page, "/today");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Who replied" }).click();
    await page.waitForURL("**/replies");
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("region", { name: "Wrong number, 1" })).toBeVisible({ timeout: 1500 });
      await expect(page.getByRole("region", { name: "Wants a visit or call, 1" })).toBeVisible({
        timeout: 1500,
      });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole("region", { name: "Asked the price, 1" })).toContainText("Varsha Kulkarni");
    await expect(page.getByRole("region", { name: "Stop messaging, 1" })).toContainText(
      "LUME marked these do not contact.",
    );
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `who-replied-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });

    const wrong = page.getByRole("region", { name: "Wrong number, 1" });
    await wrong.getByRole("button", { name: "Mark do not contact" }).click();
    const toast = page.getByRole("status").filter({ hasText: "1 lead marked do not contact" });
    await expect(toast).toBeVisible();
    const dnc = async () =>
      (await callApi<{ lead: { doNotContact: unknown } }>(page, "GET", `/api/v1/leads/${made[1]}`)).data.lead
        .doNotContact;
    expect(await dnc()).not.toBeNull();
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect.poll(dnc, { timeout: 15_000 }).toBeNull();
  });

  test("on a phone: one group under another", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openApp(page, "/replies");
    await expect(page.getByRole("region", { name: /^Asked the price/ })).toBeVisible();
    await settle(page);
    await reviewCopy(page, "who-replied-phone.png");
    expect(await axe(page)).toEqual([]);
  });
});
