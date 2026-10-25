import { createHash, createHmac } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import pg from "pg";
import { roleUrl } from "@lume/db";
import { inbound } from "../../../packages/core/src/whatsapp/fixtures";
import { callApi, expect, nearBusinessMidnight, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * Autopilot, end to end (A3; spec 2026-10-19 §1–§2): a person starts LUME AI on leads from the island, watches it
 * type and send, pauses it mid-message (nothing goes), takes a lead over mid-message, gets a converted lead in Ready
 * for you, and sees it all on a phone; someone who didn't start it watches without controls. Against the fake Meta
 * (through the real relay) and the fake LUME AI, whose answers follow the lead's own words (apps/api/src/ai/fake.ts).
 * Everything it makes is put back, so later specs see the workspace as it was.
 */
const RELAY = "http://127.0.0.1:3115";
const META = "http://127.0.0.1:3114";
const RELAY_TOKEN = "e2e-relay-token-0123456789-abcdefghij";
const INSTANCE = createHash("sha256").update(RELAY_TOKEN).digest("hex").slice(0, 16);
const APP_SECRET = "meta-app-secret-for-tests";
const TARUN = "+919876540101";
const ISHITA = "+919876540102";
const PHOTOS_REPLY = "Here are a few photos of our recent work";

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
/** A webhook as Meta sends it to the relay: signed with the app secret. */
async function meta(request: APIRequestContext, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
  const r = await request.post(`${RELAY}/wa/in/${INSTANCE}`, {
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    data: raw,
  });
  expect(r.status()).toBe(200);
}
/** The lead writes on WhatsApp, now. */
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
type Sent = { sent: { to: string; type: string; text?: string }[] };
/** What reached the fake Meta for this number. */
async function sentTo(request: APIRequestContext, phone: string) {
  const r = (await (await request.get(`${META}/__fake/sent`)).json()) as Sent;
  return r.sent.filter((m) => m.to === phone.slice(1));
}
/** e2e's own setup, as a test sets a fixture: the number on Meta's unlimited tier, so a short run isn't paced for hours. */
async function unlimitedTier() {
  const c = new pg.Client({ connectionString: roleUrl("lume_owner", "lume_e2e") });
  await c.connect();
  try {
    await c.query("UPDATE whatsapp_numbers SET messaging_tier = 'TIER_UNLIMITED', quality = 'green'");
  } finally {
    await c.end();
  }
}
/** Clear the notices this spec caused (Ready for you, needs you), and only those, as ai-settings.spec does. */
async function clearOurNotices(page: Page) {
  const list = await callApi<{ items: { id: number; title: string }[] }>(
    page,
    "GET",
    "/api/v1/notifications",
  );
  if (list.status !== 200) return;
  // Its leads' notices (replies, Ready for you), and WhatsApp's approval of its template.
  const ours = list.data.items
    .filter((n) => /^(Tarun|Ishita|Kiran)\b/.test(n.title) || n.title.includes("Hello from the studio"))
    .map((n) => n.id);
  if (!ours.length) return;
  await callApi(page, "POST", "/api/v1/notifications/read", { ids: ours });
  const cleared = await callApi<{ cleared: number[] }>(page, "POST", "/api/v1/notifications/clear-read");
  const others = cleared.data.cleared.filter((id) => !ours.includes(id));
  if (others.length) await callApi(page, "POST", "/api/v1/notifications/clear-read/undo", { ids: others });
}

const made: string[] = [];
let templateId: string | null = null;
let hoursBefore: unknown = null;
let runUrl = "";

test.describe.serial("Autopilot", () => {
  test.use({ storageState: stateFile("owner") });
  // A run paces its messages (20 s apart at the least): these wait on real sends, longer than a page test.
  test.describe.configure({ timeout: 180_000 });
  test.skip(nearBusinessMidnight(), "A run keeps to the business's day; too close to its midnight.");

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    // WhatsApp connected through Meta's signup and the relay, as whatsapp.spec does it.
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
    await card.getByRole("switch", { name: "Reply from LUME" }).click();
    await expect(card.getByRole("switch", { name: "Reply from LUME" })).toBeChecked();
    await unlimitedTier();
    expect((await callApi(page, "PUT", "/api/v1/integrations/ai", { enabled: true })).status).toBe(200);
    // The whole day is working time here, so the run never waits for tomorrow.
    const s = await callApi<{ workingHours: unknown }>(page, "GET", "/api/v1/settings");
    hoursBefore = s.data.workingHours;
    expect(
      (
        await callApi(page, "PATCH", "/api/v1/settings", {
          workingHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
        })
      ).status,
    ).toBe(200);
    // An approved template to start conversations with.
    const t = await callApi<{ id: string }>(page, "POST", "/api/v1/templates", {
      name: "Hello from the studio",
      category: "first_touch",
      body: "Hi {{lead.first_name}}, thanks for your enquiry. Shall we find a time to talk?",
    });
    templateId = t.data.id;
    expect(
      (await callApi(page, "POST", `/api/v1/templates/${t.data.id}/whatsapp`, { language: "en" })).status,
    ).toBe(202);
    const decided = await page.request.post(`${META}/__fake/template`, {
      data: { status: "APPROVED", to: `${RELAY}/wa/in/${INSTANCE}` },
    });
    expect(((await decided.json()) as { delivered: number }).delivered).toBe(200);
    for (const [name, phone] of [
      ["Tarun Dsouza", TARUN],
      ["Ishita Dsouza", ISHITA],
      ["Kiran Dsouza", null],
    ] as const) {
      const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", {
        name,
        ...(phone ? { phone } : {}),
      });
      expect(r.status).toBe(201);
      made.push(r.data.lead.id);
    }
    await ctx.close();
  });

  // Leave the workspace as it was: the run ended, LUME AI off, WhatsApp gone, the hours back, the template archived,
  // the leads deleted and the notices this spec caused cleared.
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/today");
    const runs = await callApi<{ runs: { id: string; status: string }[] }>(
      page,
      "GET",
      "/api/v1/autopilot/runs",
    );
    for (const r of runs.data.runs ?? [])
      if (r.status !== "ended") await callApi(page, "POST", `/api/v1/autopilot/runs/${r.id}/end`);
    await callApi(page, "PUT", "/api/v1/integrations/ai", { enabled: false });
    const n = await callApi<{ numbers: { id: string }[] }>(page, "GET", "/api/v1/whatsapp/numbers");
    for (const x of n.data.numbers ?? []) await callApi(page, "DELETE", `/api/v1/whatsapp/numbers/${x.id}`);
    // Replying from LUME back off too: whatsapp.spec switches it on from off.
    await callApi(page, "PUT", "/api/v1/integrations/whatsapp", { replyFromLume: false });
    await callApi(page, "PUT", "/api/v1/integrations/whatsapp", { enabled: false });
    if (hoursBefore) await callApi(page, "PATCH", "/api/v1/settings", { workingHours: hoursBefore });
    if (templateId) await callApi(page, "POST", `/api/v1/templates/${templateId}/archive`);
    if (made.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    await clearOurNotices(page);
    await ctx.close();
    // WhatsApp's approval of the template reached every admin: the admin's bell too (their centre is screenshotted
    // later). Their app may not be open to them yet, so the API's origin, as ai-settings.spec does.
    const admin = await browser.newContext({ storageState: stateFile("admin") });
    const adminPage = await admin.newPage();
    await adminPage.goto("/api/v1/auth/csrf");
    await clearOurNotices(adminPage);
    await admin.close();
  });

  test("a new person finds Autopilot in the sidebar, and what it does before any run", async ({ page }) => {
    await openApp(page, "/today");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Autopilot" }).click();
    await page.waitForURL("**/autopilot");
    await expect(page.getByRole("heading", { name: "Autopilot", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Let LUME AI work your leads" })).toBeVisible();
    await expect(
      page.getByText("Select leads on Leads, then choose Let LUME AI handle these."),
    ).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `autopilot-empty-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("start from the island: the goal, who it speaks as, what it may do, and what Start will do", async ({
    page,
  }) => {
    await openApp(page, "/leads?q=Dsouza");
    await expect(page.getByRole("row", { name: /Kiran Dsouza/ })).toBeVisible();
    await page.getByRole("checkbox", { name: "Select all loaded" }).check();
    await page.getByRole("button", { name: "Let LUME AI handle these" }).click();
    const sheet = page.getByRole("dialog", { name: "Let LUME AI handle 3 leads" });
    const goal = sheet.getByRole("radiogroup", { name: "Goal" });
    await expect(goal.getByRole("radio").first()).toHaveAttribute("aria-checked", "true");
    await expect(sheet.getByText(/^2 first messages/)).toBeVisible({ timeout: 15_000 });
    await sheet.getByRole("button", { name: "1 skipped" }).click();
    await expect(sheet.getByRole("list", { name: "Skipped leads" })).toContainText("No WhatsApp number · 1");
    // Write your own: Start waits for the goal to be confirmed.
    await goal.getByRole("radio", { name: "Write your own" }).click();
    await expect(sheet.getByRole("button", { name: "Start the run" })).toBeDisabled();
    await expect(sheet.getByText("Confirm your goal to start the run")).toBeVisible();
    await sheet.getByRole("button", { name: "Use an example" }).click();
    await sheet.getByRole("button", { name: "Confirm" }).click();
    await expect(sheet.getByText("Your goal is locked in. LUME AI writes from this.")).toBeVisible();
    // Hands-off, whatever earlier specs left as the standing choices: this run replies by itself.
    await sheet.getByRole("button", { name: /^Hands-off/ }).click();
    await expect(sheet.getByRole("button", { name: /^Hands-off/ })).toHaveAttribute("aria-pressed", "true");
    // Book meetings can't be used here: it's off, with why.
    await expect(sheet.getByText("Needs a calendar LUME can book into.")).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(sheet, `autopilot-start-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await sheet.getByRole("button", { name: "Start the run" }).click();
    await expect(sheet).toBeHidden();
    const toast = page.getByText("LUME AI is on 1 of 2");
    await expect(toast).toBeVisible();
    await page.getByRole("button", { name: "Watch it live" }).click();
    await page.waitForURL("**/autopilot?run=*");
    runUrl = new URL(page.url()).pathname + new URL(page.url()).search;
  });

  test("watch it work: the first messages type themselves and go, as approved templates", async ({
    page,
  }) => {
    await openApp(page, runUrl);
    const bar = page.getByRole("region", { name: /Your goal · 3 leads/ });
    await expect(bar).toBeVisible();
    await expect.poll(async () => (await sentTo(page.request, TARUN)).length, { timeout: 60_000 }).toBe(1);
    await expect.poll(async () => (await sentTo(page.request, ISHITA)).length, { timeout: 90_000 }).toBe(1);
    expect((await sentTo(page.request, TARUN))[0]!.type).toBe("template");
    await expect(bar).toContainText("Waiting for replies", { timeout: 20_000 });
    const leads = page.getByRole("list", { name: "Leads in this run" });
    await expect(leads.getByRole("button", { name: /Tarun Dsouza, Sent/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "1 skipped" })).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `autopilot-live-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("pause while LUME AI types: the message freezes and never goes; resume and it's written again", async ({
    page,
  }) => {
    await openApp(page, runUrl);
    await writes(page.request, ISHITA, "Do you have photos of past work?");
    const typing = page.getByRole("button", { name: "Take over Ishita: type your own message" });
    await expect(typing).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("status").filter({ hasText: "Nothing is sent until you resume." }),
    ).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `autopilot-paused-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    // Well past its typing time: nothing reached WhatsApp, and the thread doesn't show it.
    await page.waitForTimeout(10_000);
    expect((await sentTo(page.request, ISHITA)).length).toBe(1);
    await expect(page.getByRole("list", { name: "WhatsApp messages with Ishita" })).not.toContainText(
      PHOTOS_REPLY,
    );
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await sentTo(page.request, ISHITA)).length, { timeout: 60_000 }).toBe(2);
    expect((await sentTo(page.request, ISHITA))[1]!.text).toContain(PHOTOS_REPLY);
  });

  test("take over by clicking LUME AI's message: the half-typed words are yours; hand it back", async ({
    page,
  }) => {
    await openApp(page, runUrl);
    await writes(page.request, ISHITA, "Lovely, any more photos?");
    const typing = page.getByRole("button", { name: "Take over Ishita: type your own message" });
    await expect(typing).toBeVisible({ timeout: 30_000 });
    await typing.click();
    const box = page.getByRole("textbox", { name: "Message to Ishita" });
    await expect(box).toBeFocused();
    await expect(box).toHaveValue(new RegExp(`^${PHOTOS_REPLY}`));
    const leads = page.getByRole("list", { name: "Leads in this run" });
    await expect(leads.getByRole("button", { name: /Ishita Dsouza, With you/ })).toBeVisible();
    // It never went: LUME AI stopped where it was.
    await page.waitForTimeout(8_000);
    expect((await sentTo(page.request, ISHITA)).length).toBe(2);
    await page.getByRole("button", { name: "Hand back to LUME AI" }).click();
    await expect(
      leads.getByRole("button", { name: /Ishita Dsouza, (Replied|Writing|Talking)/ }),
    ).toBeVisible();
  });

  test("a lead says yes: Ready for you, with their own words, and LUME says so", async ({ page }) => {
    await openApp(page, runUrl);
    await writes(page.request, TARUN, "Saturday works for me");
    const card = page.getByRole("article", { name: "Tarun Dsouza" });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("Agreed to meet.");
    await expect(card).toContainText("Saturday works for me");
    await expect(page.getByText("Tarun is ready for you. Want to take over?")).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `autopilot-ready-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("on a phone: Live or Ready, one lead at a time, Pause in reach", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, runUrl);
    const show = page.getByRole("radiogroup", { name: "Show" });
    await expect(show).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause (Esc)" })).toBeVisible();
    // Nothing wider than the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await show.getByRole("radio", { name: /^Ready/ }).click();
    await expect(page.getByRole("article", { name: "Tarun Dsouza" })).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `autopilot-phone-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("someone who didn't start it, and can't see these leads, watches without controls", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ storageState: stateFile("seller") });
    const page = await ctx.newPage();
    await openApp(page, runUrl);
    await expect(page.getByRole("region", { name: /Your goal · 3 leads/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause (Esc)" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "End run" })).toHaveCount(0);
    await expect(page.getByText("Tarun Dsouza")).toHaveCount(0);
    await ctx.close();
  });

  test("two windows on the same run: Pause in one shows in the other, and Resume", async ({
    page,
    browser,
  }) => {
    const other = await browser.newContext({ storageState: stateFile("owner") });
    const second = await other.newPage();
    await openApp(page, runUrl);
    await openApp(second, runUrl);
    const bar = (p: Page) => p.getByRole("region", { name: /Your goal · 3 leads/ });
    await page.getByRole("button", { name: "Pause (Esc)" }).click();
    await expect(bar(second)).toContainText("Paused", { timeout: 15_000 });
    await second.getByRole("button", { name: "Resume" }).click();
    await expect(bar(page)).not.toContainText("Paused", { timeout: 15_000 });
    await other.close();
  });

  test("End run asks first, then nothing more is sent", async ({ page }) => {
    await openApp(page, runUrl);
    await page.getByRole("button", { name: "End run" }).click();
    const ask = page.getByRole("dialog", { name: "End this run?" });
    await expect(ask).toContainText("Nothing more is sent. Every lead keeps its conversation.");
    await ask.getByRole("button", { name: "End run" }).click();
    await expect(page.getByRole("region", { name: /Your goal · 3 leads/ })).toContainText("Done");
    const before = (await sentTo(page.request, ISHITA)).length;
    await writes(page.request, ISHITA, "Hello? Are you there?");
    await page.waitForTimeout(6_000);
    expect((await sentTo(page.request, ISHITA)).length).toBe(before);
  });
});
