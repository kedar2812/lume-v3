import { createHash, createHmac } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import { echo, inbound, statuses } from "../../../packages/core/src/whatsapp/fixtures";
import { callApi, expect, freezeVolatile, openApp, reviewCopy, stateFile, test } from "./fixtures";
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
    await expect(sheet).toContainText("Broadcast lists stop working in the app.");
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
    const drawer = page.getByRole("dialog", { name: "Sneha Reddy" });
    await expect(async () => {
      await drawer.getByRole("tab", { name: "WhatsApp" }).click();
      await expect(drawer.getByRole("list", { name: "WhatsApp messages with Sneha" })).toContainText(
        "Yes, Saturday works",
        {
          timeout: 1000,
        },
      );
    }).toPass({ timeout: 20_000 });
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
      await page.getByRole("dialog", { name: "Sneha Reddy" }).getByRole("tab", { name: "WhatsApp" }).click();
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
    const drawer = page.getByRole("dialog", { name: "Ananya Rao" });
    const form = drawer.getByRole("form", { name: "Reply to Ananya on WhatsApp" });
    await expect(async () => {
      await drawer.getByRole("tab", { name: "WhatsApp" }).click();
      await expect(form).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await expect(form).toContainText("You can reply until");

    // Words, sent with Enter.
    await form.getByRole("textbox", { name: "Message to Ananya" }).fill("Of course, sending it now.");
    await form.getByRole("textbox", { name: "Message to Ananya" }).press("Enter");
    const list = drawer.getByRole("list", { name: "WhatsApp messages with Ananya" });
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

  test("the file library: an admin adds a PDF and shares it by link; it goes from the reply box too (W3b-1)", async ({
    page,
    browser,
  }) => {
    const PDF = Buffer.from("%PDF-1.7\n1 0 obj\nendobj\n");
    await openApp(page, "/settings/files");
    await page.getByLabel("Choose files").setInputFiles({
      name: "Price list.pdf",
      mimeType: "application/pdf",
      buffer: PDF,
    });
    const row = page.getByRole("listitem", { name: "Price list.pdf" });
    await expect(row).toContainText("PDF · 1 KB");

    // Shared by link: anyone with it gets the file, signed in or not; switched off, the same address is gone.
    await row.getByRole("switch", { name: "Share Price list.pdf by link" }).click();
    const url = (await row.getByText(/\/f\/[A-Za-z0-9_-]{43}$/).textContent())!;
    expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    const stranger = await browser.newContext();
    const got = await stranger.request.get(url);
    expect(got.status()).toBe(200);
    expect(got.headers()["content-type"]).toBe("application/pdf");
    expect(Buffer.from(await got.body()).equals(PDF)).toBe(true);
    // The count is read when the page loads.
    await openApp(page, "/settings/files");
    await expect(row).toContainText("Opened once");
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `files-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await row.getByRole("switch", { name: "Share Price list.pdf by link" }).click();
    await expect(row).toContainText("Anyone with the old link now sees nothing.");
    expect((await stranger.request.get(url)).status()).toBe(404);
    await stranger.close();

    // From the reply box: Attach → From your files, and it reaches Meta as a document with its name.
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
    const drawer = page.getByRole("dialog", { name: "Meera Iyer" });
    const form = drawer.getByRole("form", { name: "Reply to Meera on WhatsApp" });
    await expect(async () => {
      await drawer.getByRole("tab", { name: "WhatsApp" }).click();
      await expect(form).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await form.getByRole("button", { name: "Attach" }).click();
    await form.getByRole("menuitem", { name: "From your files" }).click();
    await expect(form.getByRole("option", { name: /Price list\.pdf/ })).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(drawer, `attach-from-files-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await form.getByRole("option", { name: /Price list\.pdf/ }).click();
    // The picker closes with the pick (its exit can still be on screen a moment under load).
    await expect(form.getByRole("listbox", { name: "Your files" })).toBeHidden();
    await expect(form.getByText("PDF · 1 KB")).toBeVisible();
    await form.getByRole("textbox", { name: "Words with the file" }).fill("Our prices");
    await form.getByRole("button", { name: "Send" }).click();
    type Sent = { sent: { to: string; type: string; filename?: string }[] };
    await expect
      .poll(
        async () =>
          ((await (await page.request.get(`${META}/__fake/sent`)).json()) as Sent).sent
            .filter((m) => m.to === "919876512399")
            .map((m) => [m.type, m.filename]),
        { timeout: 20_000 },
      )
      .toEqual([["document", "Price list.pdf"]]);

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
    const drawer = page.getByRole("dialog", { name: "Kavya Nair" });
    await drawer.getByRole("tab", { name: "WhatsApp" }).click();
    const pick = drawer.getByRole("region", { name: "Send an approved template" });
    const option = pick.getByRole("radio", { name: /Price list/ });
    await expect(option).toContainText("Hi Kavya, here is our price list, as promised. Have a look!");
    await expect(option).toContainText("WhatsApp charges about ₹0.86 + GST for this.");
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(drawer, `template-pick-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await option.click();
    await pick.getByRole("button", { name: "Send template" }).click();
    const list = drawer.getByRole("list", { name: "WhatsApp messages with Kavya" });
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
      const drawer = page.getByRole("dialog", { name: "Karan Mehta" });
      await expect(async () => {
        await drawer.getByRole("tab", { name: "WhatsApp" }).click();
        await expect(drawer.getByRole("list", { name: "WhatsApp messages with Karan" })).toContainText(
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
});
