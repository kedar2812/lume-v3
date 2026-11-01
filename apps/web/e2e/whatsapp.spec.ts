import { createHash, createHmac } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import { echo, inbound, statuses } from "../../../packages/core/src/whatsapp/fixtures";
import { callApi, expect, freezeVolatile, openApp, openChat, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * WhatsApp, part 1 (spec 2026-10-18 §3–4), end to end: the real relay (e2e/relay.ts) and the fake Meta
 * (e2e/meta-fake.ts). Everything but Facebook's own popup runs as on a client's server: the test posts what the
 * signup page would, and delivers webhooks signed the way Meta signs them.
 */
const RELAY = "http://127.0.0.1:3115";
const META = "http://127.0.0.1:3114";
const RELAY_TOKEN = "e2e-relay-token-0123456789-abcdefghij";
const INSTANCE = createHash("sha256").update(RELAY_TOKEN).digest("hex").slice(0, 16);
const APP_SECRET = "meta-app-secret-for-tests";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

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
const made: string[] = [];
async function lead(page: Page, name: string, phone: string): Promise<string> {
  const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", { name, phone });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  made.push(r.data.lead.id);
  return r.data.lead.id;
}
const volatile = (page: Page) => [
  page.locator("[data-volatile]"),
  page.getByRole("button", { name: /^Notifications/ }),
];

test.describe.serial("WhatsApp", () => {
  test.use({ storageState: stateFile("owner") });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/leads");
    const n = await callApi<{ numbers: { id: string }[] }>(page, "GET", "/api/v1/whatsapp/numbers");
    for (const x of n.data.numbers ?? []) await callApi(page, "DELETE", `/api/v1/whatsapp/numbers/${x.id}`);
    await callApi(page, "PUT", "/api/v1/integrations/whatsapp", { enabled: false });
    if (made.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    await ctx.close();
  });

  test("an admin connects the business's number, through Meta's signup and the relay", async ({ page }) => {
    await openApp(page, "/settings/integrations");
    const card = page.getByRole("article", { name: /^WhatsApp/ });
    await card.getByRole("switch", { name: "WhatsApp" }).click();
    await card.getByRole("button", { name: "Connect a WhatsApp number" }).click();
    const sheet = page.getByRole("dialog", { name: "Connect a WhatsApp number" });
    await expect(sheet).toContainText("Broadcast lists stop");
    await sheet.getByRole("button", { name: "Continue with Facebook" }).click();
    // The relay's signup page (Facebook's popup can't run here): what it would post when the person finishes.
    await page.waitForURL(`${RELAY}/wa/start**`, { waitUntil: "domcontentloaded" });
    const state = await page.locator('input[name="state"]').inputValue();
    const done = await page.request.post(`${RELAY}/wa/done`, {
      form: { state, code: "good-code", waba_id: "102290129340398", phone_number_id: "106540352242922" },
      maxRedirects: 0,
    });
    expect(done.status()).toBe(302);
    await page.goto(done.headers().location!);
    await page.waitForURL("**/settings/integrations");
    await expect(page.getByText("WhatsApp connected")).toBeVisible();
    await expect(card.getByText("+91 90000 00001")).toBeVisible();
    await expect(card.getByRole("combobox", { name: "Whose number is +91 90000 00001?" })).toHaveValue("");
  });

  test("a reply lands on the lead by itself, with the bell; a photo shows once fetched; the phone's message answers Sent?", async ({
    page,
  }) => {
    await openApp(page, "/leads");
    const id = await lead(page, "Sneha Reddy", "+919876543210");
    await meta(
      page.request,
      inbound({
        id: "wamid.E2E1",
        at: new Date().toISOString(),
        text: { body: "Yes, Saturday works" },
        type: "text",
      }),
    );
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Sneha Reddy", exact: true });
    await expect(async () => {
      const chat = await openChat(page, drawer, "Sneha Reddy");
      await expect(chat.getByRole("list", { name: "WhatsApp messages with Sneha" })).toContainText(
        "Yes, Saturday works",
        {
          timeout: 1000,
        },
      );
    }).toPass({ timeout: 20_000 });
    // The tab's icon sits beside its word, never above it (owner, 2026-10-31: the live build stacked them).
    const beside = await drawer.getByRole("tab", { name: "WhatsApp" }).evaluate((tab) => {
      const icon = tab.querySelector("img")!.getBoundingClientRect();
      const range = document.createRange();
      const word = [...tab.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())!;
      range.selectNodeContents(word);
      const text = range.getBoundingClientRect();
      return {
        leftOf: icon.right <= text.left + 0.5,
        centred: Math.abs(icon.top + icon.height / 2 - (text.top + text.height / 2)) <= 2,
      };
    });
    expect(beside).toEqual({ leftOf: true, centred: true });
    await expect(page.getByRole("button", { name: /^Notifications/ })).toBeVisible();
    const notes = await callApi<{ items: { title: string }[] }>(page, "GET", "/api/v1/notifications");
    expect(notes.data.items.map((n) => n.title)).toContain("Sneha replied on WhatsApp");

    // A photo: Meta holds it; LUME fetches it with the number's token.
    expect(
      (
        await page.request.post(`${META}/__fake/media`, {
          data: { id: "E2EPHOTO", mime: "image/png", base64: PNG.toString("base64") },
        })
      ).ok(),
    ).toBeTruthy();
    await meta(
      page.request,
      inbound({
        id: "wamid.E2E2",
        at: new Date().toISOString(),
        type: "image",
        image: { id: "E2EPHOTO", mime_type: "image/png" },
      }),
    );
    await expect(async () => {
      await page.reload();
      await page
        .getByRole("dialog", { name: "Sneha Reddy", exact: true })
        .getByRole("tab", { name: "WhatsApp" })
        .click();
      await expect(page.getByRole("img", { name: "Photo from Sneha" })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 30_000 });

    // Sent from the phone after opening WhatsApp in LUME: "Sent?" answers itself.
    expect(
      (await callApi(page, "POST", `/api/v1/leads/${id}/messages/prepare`, { text: "See you Saturday" }))
        .status,
    ).toBe(200);
    await meta(page.request, echo({ id: "wamid.E2E3", at: new Date().toISOString() }));
    await expect(async () => {
      const a = await callApi<{ items: { type: string }[] }>(page, "GET", `/api/v1/leads/${id}/activities`);
      expect(a.data.items.map((x) => x.type)).toContain("whatsapp_confirmed_sent");
    }).toPass({ timeout: 20_000 });
  });

  test("a stranger waits in Not a lead yet, then becomes an enquiry", async ({ page }) => {
    await openApp(page, "/leads");
    await meta(
      page.request,
      inbound({
        from: "919000000777",
        name: "Ravi K",
        id: "wamid.E2E4",
        at: new Date().toISOString(),
        type: "text",
        text: { body: "Do you do kitchens?" },
      }),
    );
    await expect(async () => {
      await openApp(page, "/leads");
      await expect(page.getByRole("link", { name: /^Not a lead yet · / })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await page.getByRole("link", { name: /^Not a lead yet · / }).click();
    await expect(page.getByRole("list", { name: "Messages from Ravi K" })).toContainText(
      "Do you do kitchens?",
    );
    await page.getByRole("button", { name: "Make it an enquiry" }).click();
    await page.waitForURL(/\/leads\?lead=/);
    const leadId = new URL(page.url()).searchParams.get("lead")!;
    made.push(leadId);
    await expect(page.getByRole("dialog", { name: "Ravi K" })).toBeVisible();
  });

  test("an admin keeps WhatsApp files for 3 months, then forever again (2026-10-19)", async ({ page }) => {
    await openApp(page, "/settings/integrations");
    const card = page.getByRole("article", { name: /^WhatsApp/ });
    const keep = card.getByRole("combobox", { name: "Keep WhatsApp files" });
    await expect(keep).toHaveValue("");
    // Every file here is from today: nothing would go, so nothing is asked.
    await keep.selectOption("3 months");
    await expect(page.getByText("WhatsApp files are kept for 3 months")).toBeVisible();
    await expect(card.getByText("Older files go from LUME. They stay on the phone.")).toBeVisible();
    await keep.selectOption("Forever");
    await expect(page.getByText("WhatsApp files are kept forever")).toBeVisible();
    await expect(keep).toHaveValue("");
  });

  test("reply from LUME: an admin switches it on; a rep replies with words and a PDF; the ticks follow (W3a)", async ({
    page,
  }) => {
    await openApp(page, "/settings/integrations");
    const card = page.getByRole("article", { name: /^WhatsApp/ });
    await card.getByRole("switch", { name: "Reply from LUME" }).click();
    await expect(card.getByRole("switch", { name: "Reply from LUME" })).toBeChecked();

    const id = await lead(page, "Ananya Rao", "+919876512345");
    await meta(
      page.request,
      inbound({
        from: "919876512345",
        name: "Ananya Rao",
        id: "wamid.E2EREPLY1",
        at: new Date().toISOString(),
        type: "text",
        text: { body: "Can you send the brochure?" },
      }),
    );
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Ananya Rao", exact: true });
    const chat = page.getByRole("dialog", { name: "WhatsApp with Ananya Rao" });
    const form = chat.getByRole("form", { name: "Reply to Ananya on WhatsApp" });
    await expect(async () => {
      await openChat(page, drawer, "Ananya Rao");
      await expect(form).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await expect(form).toContainText("You can reply until");

    // Words, sent with Enter.
    await form.getByRole("textbox", { name: "Message to Ananya" }).fill("Of course, sending it now.");
    await form.getByRole("textbox", { name: "Message to Ananya" }).press("Enter");
    const list = chat.getByRole("list", { name: "WhatsApp messages with Ananya" });
    await expect(list).toContainText("Of course, sending it now.");
    await expect(list.getByText("Sent", { exact: true })).toBeVisible({ timeout: 20_000 });

    // A PDF, with its words.
    await form.getByLabel("Attach a photo or a file").setInputFiles({
      name: "Brochure.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n1 0 obj\n"),
    });
    await expect(form.getByText("Brochure.pdf")).toBeVisible();
    await form.getByRole("textbox", { name: "Words with the file" }).fill("Our brochure");
    await form.getByRole("button", { name: "Send" }).click();
    await expect(list).toContainText("Our brochure");

    // The thread shows a message the moment it's sent; the queue hands it to Meta a moment later (slower under a
    // full run's load), so wait for both to reach Meta.
    type Sent = { sent: { to: string; type: string; wamid: string }[] };
    const toMeta = async () =>
      ((await (await page.request.get(`${META}/__fake/sent`)).json()) as Sent).sent.filter(
        (m) => m.to === "919876512345",
      );
    await expect
      .poll(async () => (await toMeta()).map((m) => m.type), { timeout: 20_000 })
      .toEqual(["text", "document"]);
    const mine = await toMeta();

    // Meta says delivered, then read: the ticks follow by themselves.
    for (const status of ["delivered", "read"])
      await meta(page.request, statuses({ id: mine[0]!.wamid, status, at: new Date().toISOString() }));
    await expect(list.getByText("Read", { exact: true })).toBeVisible({ timeout: 20_000 });

    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(drawer, `reply-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }

    // Back off, as every other test expects.
    await openApp(page, "/settings/integrations");
    await card.getByRole("switch", { name: "Reply from LUME" }).click();
    await expect(card.getByRole("switch", { name: "Reply from LUME" })).not.toBeChecked();
  });

  test("Media: an admin adds a PDF and shares it by link; two files go from the reply box as the real files (W3b-1, Media)", async ({
    page,
    browser,
  }) => {
    const PDF = Buffer.from("%PDF-1.7\n1 0 obj\nendobj\n");
    await openApp(page, "/media");
    await page.locator('input[type="file"]').setInputFiles([
      { name: "Price list.pdf", mimeType: "application/pdf", buffer: PDF },
      { name: "Showroom.png", mimeType: "image/png", buffer: PNG },
    ]);
    const tile = page
      .getByRole("list", { name: "Your media" })
      .getByRole("button", { name: /^Price list\.pdf/ });
    await expect(tile).toBeVisible({ timeout: 20_000 });
    await expect(tile).toContainText("PDF");

    // Shared by link from the file's Info: anyone with it gets the file, signed in or not; switched off, it's gone.
    const openInfo = async () => {
      await tile.click();
      const viewer = page.getByRole("dialog", { name: "Price list.pdf" });
      await viewer.getByRole("button", { name: "Info" }).click();
      return viewer.getByRole("complementary", { name: "Info" });
    };
    let info = await openInfo();
    await info.getByRole("switch", { name: "Share Price list.pdf by link" }).click();
    const url = (await info.getByText(/\/f\/[A-Za-z0-9_-]{43}$/).textContent())!;
    expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    const stranger = await browser.newContext();
    const got = await stranger.request.get(url);
    expect(got.status()).toBe(200);
    expect(got.headers()["content-type"]).toBe("application/pdf");
    expect(Buffer.from(await got.body()).equals(PDF)).toBe(true);
    // The count is read when the page loads.
    await openApp(page, "/media");
    info = await openInfo();
    await expect(info).toContainText("Opened once");
    await info.getByRole("switch", { name: "Share Price list.pdf by link" }).click();
    await expect(info).toContainText("Anyone with the old link now sees nothing.");
    expect((await stranger.request.get(url)).status()).toBe(404);
    await stranger.close();
    await page.keyboard.press("Escape");

    // From the reply box: Attach → From Media, two at once, and each reaches Meta as itself.
    await openApp(page, "/settings/integrations");
    const card = page.getByRole("article", { name: /^WhatsApp/ });
    await card.getByRole("switch", { name: "Reply from LUME" }).click();
    await expect(card.getByRole("switch", { name: "Reply from LUME" })).toBeChecked();
    const id = await lead(page, "Meera Iyer", "+919876512399");
    await meta(
      page.request,
      inbound({
        from: "919876512399",
        name: "Meera Iyer",
        id: "wamid.E2ELIBRARY1",
        at: new Date().toISOString(),
        type: "text",
        text: { body: "What do you charge?" },
      }),
    );
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Meera Iyer", exact: true });
    const chat = page.getByRole("dialog", { name: "WhatsApp with Meera Iyer" });
    const form = chat.getByRole("form", { name: "Reply to Meera on WhatsApp" });
    await expect(async () => {
      await openChat(page, drawer, "Meera Iyer");
      await expect(form).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await form.getByRole("button", { name: "Attach" }).click();
    await form.getByRole("menuitem", { name: "From Media" }).click();
    await form.getByRole("option", { name: /Price list\.pdf/ }).click();
    await form.getByRole("option", { name: /Showroom\.png/ }).click();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(drawer, `attach-from-media-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await form.getByRole("button", { name: "Attach 2 files" }).click();
    // The picker closes with the pick (its exit can still be on screen a moment under load).
    await expect(form.getByRole("listbox", { name: "Media" })).toBeHidden();
    await expect(form.getByRole("button", { name: "Remove Price list.pdf" })).toBeVisible();
    await expect(form.getByRole("button", { name: "Remove Showroom.png" })).toBeVisible();
    await form.getByRole("textbox", { name: "Words with the files" }).fill("Our prices, and our showroom");
    await form.getByRole("button", { name: "Send" }).click();
    type Sent = { sent: { to: string; type: string; filename?: string }[] };
    await expect
      .poll(
        async () =>
          ((await (await page.request.get(`${META}/__fake/sent`)).json()) as Sent).sent
            .filter((m) => m.to === "919876512399")
            .map((m) => [m.type, m.filename ?? null]),
        { timeout: 20_000 },
      )
      .toEqual([
        ["document", "Price list.pdf"],
        ["image", null],
      ]);

    await openApp(page, "/settings/integrations");
    await card.getByRole("switch", { name: "Reply from LUME" }).click();
    await expect(card.getByRole("switch", { name: "Reply from LUME" })).not.toBeChecked();
  });

  test("approved templates: an admin submits one with a PDF at the top, WhatsApp approves it, and it reaches a lead who never wrote (W3b-2)", async ({
    page,
  }) => {
    const hookTo = `${RELAY}/wa/in/${INSTANCE}`;
    const decide = async (o: { status: string; reason?: string }) => {
      const r = await page.request.post(`${META}/__fake/template`, { data: { ...o, to: hookTo } });
      expect(((await r.json()) as { delivered: number }).delivered).toBe(200);
    };
    await openApp(page, "/templates");
    const made = await callApi<{ id: string }>(page, "POST", "/api/v1/templates", {
      name: "Price list",
      category: "first_touch",
      body: "Hi {{lead.first_name}}, here is our price list, as promised. Have a look!",
    });
    expect(made.status).toBe(201);

    // In the template: WhatsApp approval, with the library's PDF at the top.
    await openApp(page, "/templates");
    await page.getByRole("list", { name: "First touch" }).getByText("Price list", { exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Price list" });
    const panel = editor.getByRole("region", { name: "WhatsApp approval" });
    await expect(panel).toContainText("To send it to someone outside WhatsApp's 24 hours");
    await panel.getByRole("button", { name: "Add a file at the top" }).click();
    await panel.getByRole("option", { name: /Price list\.pdf/ }).click();
    await panel.getByRole("button", { name: "Submit to WhatsApp" }).click();
    await expect(panel.getByText("With WhatsApp for review")).toBeVisible();

    // WhatsApp approves it, by its webhook through the relay.
    await decide({ status: "APPROVED" });
    await openApp(page, "/templates");
    await page.getByRole("list", { name: "First touch" }).getByText("Price list", { exact: true }).click();
    await expect(panel.getByText("Approved", { exact: true })).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(editor, `template-approval-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });

    // From the reply box, to a lead who never wrote.
    await openApp(page, "/settings/integrations");
    const card = page.getByRole("article", { name: /^WhatsApp/ });
    await card.getByRole("switch", { name: "Reply from LUME" }).click();
    await expect(card.getByRole("switch", { name: "Reply from LUME" })).toBeChecked();
    const id = await lead(page, "Kavya Nair", "+919876512377");
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Kavya Nair", exact: true });
    const chat = await openChat(page, drawer, "Kavya Nair");
    const pick = chat.getByRole("region", { name: "Send an approved template" });
    const option = pick.getByRole("radio", { name: /Price list/ });
    await expect(option).toContainText("Hi Kavya, here is our price list, as promised. Have a look!");
    await expect(option).toContainText("WhatsApp charges about ₹0.86 + GST for this.");
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(chat, `template-pick-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await option.click();
    await pick.getByRole("button", { name: "Send template" }).click();
    const list = chat.getByRole("list", { name: "WhatsApp messages with Kavya" });
    await expect(list).toContainText("Hi Kavya, here is our price list");

    type Sent = {
      sent: {
        to: string;
        type: string;
        wamid: string;
        template?: { values: string[]; header: string | null };
      }[];
    };
    const toMeta = async () =>
      ((await (await page.request.get(`${META}/__fake/sent`)).json()) as Sent).sent.filter(
        (m) => m.to === "919876512377",
      );
    await expect
      .poll(async () => (await toMeta()).map((m) => [m.type, m.template?.values, m.template?.header]), {
        timeout: 20_000,
      })
      .toEqual([["template", ["Kavya"], "document"]]);
    const [mine] = await toMeta();
    for (const status of ["delivered", "read"])
      await meta(page.request, statuses({ id: mine!.wamid, status, at: new Date().toISOString() }));
    await expect(list.getByText("Read", { exact: true })).toBeVisible({ timeout: 20_000 });

    // Another one WhatsApp turns down: its reason, in LUME's words.
    const other = await callApi<{ id: string }>(page, "POST", "/api/v1/templates", {
      name: "Come back",
      category: "re_engagement",
      body: "Hello again from the studio. Shall we pick up where we left off this week?",
    });
    expect(other.status).toBe(201);
    expect(
      (await callApi(page, "POST", `/api/v1/templates/${other.data.id}/whatsapp`, { language: "en" })).status,
    ).toBe(202);
    await decide({ status: "REJECTED", reason: "INCORRECT_CATEGORY" });
    await openApp(page, "/templates");
    await page.getByRole("list", { name: "Re-engagement" }).getByText("Come back", { exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Come back" })
        .getByText("Turned down: WhatsApp thinks it belongs in another category."),
    ).toBeVisible();

    await openApp(page, "/settings/integrations");
    await card.getByRole("switch", { name: "Reply from LUME" }).click();
    await expect(card.getByRole("switch", { name: "Reply from LUME" })).not.toBeChecked();
  });

  test("System health shows the disk, the database and WhatsApp's files — both themes", async ({ page }) => {
    await openApp(page, "/settings/health");
    const storage = page.getByRole("region", { name: "Storage" });
    await expect(storage).toContainText("WhatsApp files");
    await expect(storage).toContainText("Database");
    await expect(storage.getByRole("meter", { name: "Server disk in use" })).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(storage, `storage-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
  });

  test("screenshots and axe: the card, the connect sheet, the thread and Not a lead yet — both themes", async ({
    page,
  }) => {
    await openApp(page, "/leads");
    await meta(
      page.request,
      inbound({
        from: "919000000888",
        name: "Mehta Timbers",
        id: "wamid.E2E5",
        at: new Date().toISOString(),
        type: "text",
        text: { body: "Your plywood is ready." },
      }),
    );
    const id = await lead(page, "Karan Mehta", "+919876500011");
    await meta(
      page.request,
      inbound({
        from: "919876500011",
        id: "wamid.E2E6",
        at: new Date().toISOString(),
        type: "text",
        text: { body: "Can we meet on Monday?" },
      }),
    );
    await meta(
      page.request,
      echo({
        to: "919876500011",
        id: "wamid.E2E7",
        at: new Date().toISOString(),
        text: "Monday 11 am works.",
      }),
    );
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/settings/integrations");
      const card = page.getByRole("article", { name: /^WhatsApp/ });
      await expect(card.getByText("+91 90000 00001")).toBeVisible();
      await reviewCopy(card, `card-${theme}.png`);
      await freezeVolatile(page);
      await expect(card).toHaveScreenshot(`card-${theme}.png`, { mask: volatile(page) });
      expect(await axe(page)).toEqual([]);
      await card.getByRole("button", { name: "Connect another number" }).click();
      const sheet = page.getByRole("dialog", { name: "Connect a WhatsApp number" });
      await reviewCopy(sheet, `connect-sheet-${theme}.png`);
      await expect(sheet).toHaveScreenshot(`connect-sheet-${theme}.png`);
      expect(await axe(page)).toEqual([]);
      await page.keyboard.press("Escape");

      await openApp(page, `/leads?lead=${id}`);
      const drawer = page.getByRole("dialog", { name: "Karan Mehta", exact: true });
      await expect(async () => {
        const chat = await openChat(page, drawer, "Karan Mehta");
        await expect(chat.getByRole("list", { name: "WhatsApp messages with Karan" })).toContainText(
          "Monday 11 am works.",
          {
            timeout: 1000,
          },
        );
      }).toPass({ timeout: 20_000 });
      await reviewCopy(drawer, `thread-${theme}.png`);
      expect(await axe(page)).toEqual([]);

      await openApp(page, "/leads/not-yet");
      await expect(page.getByRole("list", { name: "People who wrote" })).toContainText("Mehta Timbers");
      await reviewCopy(page.locator("main"), `not-yet-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
  });

  test("live: a message in shows in the open chat by itself; on another page it's a notice that opens the chat (2026-11-01)", async ({
    page,
  }) => {
    // Owner: "I have to close and reopen the window to see that the lead has texted me back."
    await page.setViewportSize({ width: 1366, height: 800 });
    await openApp(page, "/leads");
    await callApi(page, "PUT", "/api/v1/integrations/whatsapp", { replyFromLume: true });
    const id = await lead(page, "Ishaan Kapoor", "+919876512401");
    const says = (n: number, body: string) =>
      meta(
        page.request,
        inbound({
          from: "919876512401",
          name: "Ishaan Kapoor",
          id: `wamid.E2ELIVE${n}`,
          at: new Date().toISOString(),
          type: "text",
          text: { body },
        }),
      );
    await says(1, "Hello there");
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Ishaan Kapoor", exact: true });
    const chat = page.getByRole("dialog", { name: "WhatsApp with Ishaan Kapoor" });
    const messages = chat.getByRole("list", { name: "WhatsApp messages with Ishaan" });
    await expect(async () => {
      await openChat(page, drawer, "Ishaan Kapoor");
      await expect(messages).toContainText("Hello there", { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    // The next one arrives while the chat is open: there without reopening, and no notice for a chat on screen.
    await says(2, "Can we talk at 5?");
    await expect(messages).toContainText("Can we talk at 5?", { timeout: 15_000 });
    const notices = page.getByRole("region", { name: "Messages from your leads" });
    await expect(notices.getByRole("button", { name: /Open the chat$/ })).toHaveCount(0);
    // Elsewhere in LUME: a notice in the corner, and pressing it opens the chat.
    await openApp(page, "/today");
    await says(3, "Still there?");
    const notice = notices.getByRole("button", {
      name: "Ishaan Kapoor on WhatsApp: Still there?. Open the chat",
    });
    await expect(notice).toBeVisible({ timeout: 15_000 });
    const box = await notice.boundingBox();
    // Bottom right, clear of the edges.
    expect(box!.x + box!.width).toBeGreaterThan(1366 - 60);
    expect(box!.y + box!.height).toBeGreaterThan(800 - 60);
    await notice.click();
    // Their chat, open: Leads keeps only the lead in its address (a reload doesn't open the chat again).
    await expect(page).toHaveURL(new RegExp("/leads\\?lead=" + id));
    await expect(chat).toBeVisible();
    await expect(messages).toContainText("Still there?");
    expect(await axe(page)).toEqual([]);
  });

  test("on a phone: the chat fills the screen, the reply box whole at its foot, nothing wider than the screen (2026-10-31)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, "/leads");
    // Its own starting point: replying from LUME on, whatever the tests before it left.
    await callApi(page, "PUT", "/api/v1/integrations/whatsapp", { replyFromLume: true });
    const id = await lead(page, "Riya Kapoor", "+919876512399");
    await meta(
      page.request,
      inbound({
        from: "919876512399",
        name: "Riya Kapoor",
        id: "wamid.E2EPHONE1",
        at: new Date().toISOString(),
        type: "text",
        text: { body: "Is Saturday free for a visit?" },
      }),
    );
    await openApp(page, `/leads?lead=${id}`);
    const drawer = page.getByRole("dialog", { name: "Riya Kapoor", exact: true });
    const chat = page.getByRole("dialog", { name: "WhatsApp with Riya Kapoor" });
    await expect(async () => {
      await openChat(page, drawer, "Riya Kapoor");
      await expect(chat.getByRole("list", { name: "WhatsApp messages with Riya" })).toContainText(
        "Is Saturday free for a visit?",
        { timeout: 1000 },
      );
    }).toPass({ timeout: 20_000 });
    await settle(page);
    // The whole screen, edge to edge.
    expect(await chat.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    // The reply box whole at the foot, Close in reach, and nothing running off to the side.
    const form = chat.getByRole("form", { name: "Reply to Riya on WhatsApp" });
    await expect(form).toBeInViewport({ ratio: 1 });
    await expect(chat.getByRole("button", { name: "Close (Esc)" })).toBeInViewport({ ratio: 1 });
    expect(await chat.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(chat, `chat-phone-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
  });
});

test("a link to one card lands on it; an address that isn't a page says so (2026-10-31)", async ({
  page,
}) => {
  // Autopilot's "Fix it" led to /settings/integrations/whatsapp, read as a sheet's id: "Request is invalid", under a
  // tab titled Google Sheet. Links now name the card; the cards load after the page, which must still land on them.
  await page.setViewportSize({ width: 1366, height: 600 });
  await openApp(page, "/settings/integrations#whatsapp");
  await expect(page.getByRole("heading", { name: "WhatsApp", level: 2 })).toBeInViewport();
  await openApp(page, "/settings/integrations#sheets");
  await expect(page.getByRole("heading", { name: "Google Sheets", level: 2 })).toBeInViewport();
  const r = await page.goto("/settings/integrations/whatsapp");
  expect(r?.status()).toBe(404);
});

test("Write with LUME AI fits a phone: the request, then the drafts one under another (2026-10-31)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "/templates");
  await callApi(page, "PUT", "/api/v1/integrations/ai", { enabled: true });
  try {
    await page.reload();
    await page.getByRole("button", { name: "Write with LUME AI" }).click();
    const sheet = page.getByRole("dialog", { name: "Write with LUME AI" });
    await sheet
      .getByRole("textbox", { name: "What should this template do?" })
      .fill("Follow up after no reply");
    await sheet.getByRole("button", { name: "Write templates" }).click();
    const cards = sheet.getByRole("article");
    await expect(cards.first()).toBeVisible();
    // One under another, each the sheet's width; nothing off the side of the phone.
    const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
    expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
    expect(await sheet.evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth + 0.5)).toBe(
      true,
    );
    expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(sheet, `draft-phone-${theme}.png`);
    }
    await page.emulateMedia({ colorScheme: "light" });
  } finally {
    // Other specs see LUME AI as they left it.
    await callApi(page, "PUT", "/api/v1/integrations/ai", { enabled: false });
  }
});
