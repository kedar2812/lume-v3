import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { cleanImage } from "@lume/core/shared";

/** The seeded admin (prepare.ts) and each client's id. */
const seed = () =>
  JSON.parse(readFileSync(new URL("./.artifacts/admin.json", import.meta.url), "utf8")) as {
    email: string;
    password: string;
    secret: string;
    ids: Record<string, string>;
    /** Brightpath Studio's LUME, bound to a known install. */
    feedback: { instanceId: string; licenseKey: string; installId: string };
  };

/** The authenticator's six digits (RFC 6238), for the seeded secret. */
function totp(secretB32: string, atMs = Date.now()): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secretB32.replace(/=+$/, "")) bits += A.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/__review__/${name}.png`, fullPage: true, animations: "disabled" });
async function theme(page: Page, t: "light" | "dark") {
  await page.evaluate((x) => {
    localStorage.setItem("lume-licence-theme", x);
    document.documentElement.dataset.theme = x;
  }, t);
}

test.describe.configure({ mode: "serial" });
let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })
  ).newPage();
});

test("sign in: a password, then six digits (both steps, dark)", async () => {
  const s = seed();
  await page.goto("/clients");
  await expect(page).toHaveURL(/\/sign-in$/);
  await shot(page, "sign-in");
  expect(await axe(page)).toEqual([]);
  await page.getByLabel("Email").fill(s.email);
  await page.getByLabel("Password").fill(s.password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Two-step sign-in")).toBeVisible();
  await shot(page, "sign-in-code");
  await page.getByLabel("Code").fill(totp(s.secret));
  await expect(page.getByText("Welcome back")).toBeVisible();
  await expect(page.getByText(/15 clients · \d+ things need a look/)).toBeVisible();
  await shot(page, "sign-in-done");
  await page.getByRole("link", { name: "Open clients" }).click();
  await expect(page.getByRole("table", { name: "Clients" })).toBeVisible();
});

for (const t of ["light", "dark"] as const) {
  test(`every screen, ${t}`, async () => {
    const s = seed();
    await theme(page, t);
    await page.goto("/clients");
    await expect(page.getByRole("row", { name: "Harbour Clinic" })).toContainText("3 days overdue");
    await expect(page.getByRole("row", { name: "Oakline Realty" })).toContainText("update");
    await shot(page, `clients-${t}`);
    expect(await axe(page)).toEqual([]);

    await page.getByRole("button", { name: /things need a look/ }).click();
    await expect(page.getByRole("dialog", { name: "Needs a look" })).toContainText(
      "Harbour Clinic's payment is 3 days late",
    );
    await shot(page, `bell-${t}`);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "New licence" }).click();
    const sheet = page.getByRole("dialog", { name: "New licence" });
    await sheet.getByLabel("Business name").fill("Palm Bay Clinic");
    // Each list is named for what it is, not for the options inside it ("State" isn't "United States").
    for (const name of ["Country", "State", "Currency", "How they found LUME"])
      await expect(sheet.getByRole("combobox", { name, exact: true })).toHaveCount(1);
    await sheet.getByLabel("State", { exact: true }).selectOption("KA");
    await sheet.getByLabel("Country").selectOption("AE");
    await sheet.getByLabel("Price").fill("450");
    await expect(sheet).toContainText("≈ ₹10,832 a month in your analytics");
    await shot(page, `new-licence-${t}`);
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press("Escape");

    await page.goto(`/clients/${s.ids["Harbour Clinic"]}`);
    await expect(page.getByRole("heading", { name: "Harbour Clinic" })).toBeVisible();
    await expect(page.getByText(/Nothing heard for 3\d h/)).toBeVisible();
    await shot(page, `client-${t}`);
    expect(await axe(page)).toEqual([]);

    await page.goto("/analytics");
    await expect(page.getByRole("region", { name: "Monthly growth" })).toBeVisible();
    await page.mouse.move(700, 470);
    await shot(page, `analytics-${t}`);
    expect(await axe(page)).toEqual([]);

    for (const screen of ["releases", "payments", "settings"]) {
      await page.goto(`/${screen}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await shot(page, `${screen}-${t}`);
      expect(await axe(page), screen).toEqual([]);
    }
  });
}

test("a client's actions, end to end: New licence, Ready to send, Mark paid, the reminder, the key, Suspend", async () => {
  await theme(page, "light");
  await page.goto("/clients");
  await page.getByRole("button", { name: "New licence" }).click();
  const sheet = page.getByRole("dialog", { name: "New licence" });
  await sheet.getByLabel("Business name").fill("Palm Bay Clinic");
  await sheet.getByLabel("Country").selectOption("AE");
  await sheet.getByLabel("City", { exact: true }).fill("Dubai");
  await sheet.getByLabel("Price").fill("450");
  await sheet.getByRole("button", { name: "Create licence" }).click();
  const done = page.getByRole("dialog", { name: "Ready to send" });
  await expect(done).toContainText(/LUME(-[0-9A-Z]{4}){5}/);
  await expect(done).toContainText("Not activated yet.");
  await expect(done.getByRole("link", { name: "Send on WhatsApp" })).toHaveAttribute(
    "href",
    /^https:\/\/wa\.me\/\?text=/,
  );
  await shot(page, "licence-created");
  expect(await axe(page)).toEqual([]);
  await done.getByRole("link", { name: "Open Palm Bay Clinic" }).click();
  await expect(page.getByRole("heading", { name: "Palm Bay Clinic" })).toBeVisible();

  await page.getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByRole("status")).toContainText("Paid until");
  await page.getByRole("button", { name: "Send payment reminder" }).click();
  await page.getByRole("button", { name: "Send reminder" }).click();
  await expect(page.getByText("Reminder on.")).toBeVisible();
  const key = page.getByRole("region", { name: "Licence key" });
  await expect(key).toContainText("Not activated yet");
  await key.getByRole("button", { name: "Show" }).click();
  await expect(key).toContainText(/LUME(-[0-9A-Z]{4}){5}/);
  await key.getByRole("button", { name: "Rotate key" }).click();
  await key
    .getByRole("group", { name: "Rotate the key?" })
    .getByRole("button", { name: "Rotate key" })
    .click();
  await expect(key.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  // Hold to decommission: letting go early does nothing; a full hold decommissions the key.
  const hold = key.getByRole("button", { name: "Hold to decommission key" });
  await hold.hover();
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await expect(key).not.toContainText("Key decommissioned.");
  await hold.hover();
  await page.mouse.down();
  await page.waitForTimeout(1900);
  await page.mouse.up();
  await expect(key).toContainText("Key decommissioned.");
  await shot(page, "client-key-decommissioned");
  expect(await axe(page)).toEqual([]);
  await key.getByRole("button", { name: "Issue a new key" }).click();
  await expect(key.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  await expect(key).toContainText("Not activated yet");
  await page.getByRole("button", { name: "Suspend…" }).click();
  await page.getByRole("button", { name: "Suspend", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await shot(page, "client-after-actions");
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Suspend…" })).toBeVisible();
});

test("Feedback: a report from a client's LUME, the inbox, one report, the viewer, Fixed in, the client card and Releases", async () => {
  const s = seed();
  await theme(page, "light");
  // A real JPEG, made the way a browser makes one, and cleaned the way LUME's sheet cleans it before sending.
  const made = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1280;
    c.height = 720;
    const x = c.getContext("2d")!;
    x.fillStyle = "#eef0f3";
    x.fillRect(0, 0, 1280, 720);
    x.fillStyle = "#ffffff";
    x.fillRect(190, 10, 1080, 700);
    x.fillStyle = "#2a5bff";
    x.fillRect(220, 60, 520, 36);
    x.fillStyle = "#0a0c11";
    for (let i = 0; i < 8; i++) x.fillRect(220, 140 + i * 56, 300 + ((i * 97) % 400), 14);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1]!;
  });
  const data = Buffer.from(cleanImage(new Uint8Array(Buffer.from(made, "base64")), "image/jpeg")).toString(
    "base64",
  );
  const r = await page.request.post("/v1/feedback", {
    headers: { "x-real-ip": "198.51.100.40" },
    data: {
      ...s.feedback,
      appVersion: "1.4.1",
      browser:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      reporter: { name: "Priya Shah", email: "priya@harbour.example", role: "Sales rep" },
      kind: "bug",
      text: "I dragged a lead from Contacted to Meeting set. The card jumped back until I refreshed.\n\nTwice this morning.",
      page: "/pipeline",
      theme: "porcelain",
      screen: "1536 × 864 · 1.25×",
      images: [{ type: "image/jpeg", data }],
    },
  });
  expect(r.status(), await r.text()).toBe(201);

  await page.goto("/feedback");
  await expect(page.getByRole("link", { name: /Feedback/ }).getByLabel("1 new")).toBeVisible();
  const row = page.getByRole("link", { name: /The card jumped back/ });
  await expect(row).toBeVisible();
  for (const t of ["light", "dark"] as const) {
    await theme(page, t);
    await shot(page, `feedback-list-${t}`);
    expect(await axe(page)).toEqual([]);
  }
  await theme(page, "light");
  await row.click();
  await expect(page.getByText("Twice this morning.")).toBeVisible();
  await expect(page.getByText("Chrome 141 on Windows")).toBeVisible();
  await expect(page.getByRole("button", { name: "Seen" })).toHaveAttribute("aria-pressed", "true");
  await shot(page, "feedback-report");
  expect(await axe(page)).toEqual([]);

  await page.getByRole("button", { name: "Open screenshot 1 of 1" }).click();
  const viewer = page.getByRole("dialog", { name: "Screenshot 1 of 1" });
  await expect(viewer.getByRole("img")).toBeVisible();
  await shot(page, "feedback-viewer");
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();

  await page.getByRole("button", { name: "Fixed in…" }).click();
  await page.getByLabel("Fixed in which release?").fill("1.4.3");
  await page.getByRole("button", { name: "Mark fixed" }).click();
  const fixed = page.getByRole("button", { name: "Fixed in 1.4.3" });
  await expect(fixed).toHaveAttribute("aria-pressed", "true");
  // One line, like its neighbours.
  expect((await fixed.boundingBox())!.height).toBe(
    (await page.getByRole("button", { name: "Seen" }).boundingBox())!.height,
  );
  expect(await fixed.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  await page.getByRole("textbox", { name: "Your note" }).fill("Pipeline drag race");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await shot(page, "feedback-report-fixed");

  await page.getByRole("link", { name: "Brightpath Studio", exact: true }).first().click();
  const card = page.getByRole("region", { name: "Feedback" });
  await expect(card).toContainText("Fixed in 1.4.3");
  await shot(page, "feedback-client-card");
  expect(await axe(page)).toEqual([]);
  await card.getByRole("link", { name: /^All 1 from Brightpath Studio/ }).click();
  await expect(page).toHaveURL(/\/feedback\?client=/);
  await expect(page.getByRole("link", { name: /The card jumped back/ })).toBeVisible();

  // Releases counts it under 1.4.3 once 1.4.3 is the latest (no installation runs it yet).
  await page.goto("/settings");
  const latest = page.getByLabel("Latest version");
  // Settings loads its values first: typing before then would be added to them.
  await expect(latest).toHaveValue("1.4.2");
  await latest.fill("1.4.3");
  await latest.press("Enter");
  await expect(page.getByText("Saved")).toBeVisible();
  await page.goto("/releases");
  await expect(page.getByRole("link", { name: "Fixed 1 report" })).toBeVisible();
  await shot(page, "feedback-releases");
  await page.getByRole("link", { name: "Fixed 1 report" }).click();
  await expect(page).toHaveURL(/\/feedback\?fixedIn=1\.4\.3/);
  await expect(page.getByRole("link", { name: /The card jumped back/ })).toBeVisible();
});

test("Fleet: every LUME worst first, a client's Health card, an announcement published and withdrawn", async () => {
  await theme(page, "light");
  await page.goto("/fleet");
  const list = page.getByRole("region", { name: "Every client's LUME" });
  await expect(list.getByRole("link").first()).toContainText("Harbour Clinic");
  await expect(list.getByRole("link").first()).toContainText("Down");
  const saffron = list.getByRole("link", { name: /Saffron Events/ });
  await expect(saffron).toContainText("Disk almost full");
  await expect(saffron).toContainText("Jobs failing");
  await expect(list.getByRole("link", { name: /Oakline Realty/ })).toContainText("No health yet");
  await expect(
    page.getByRole("link", { name: /^Fleet/ }).getByLabel(/need a look or are down/),
  ).toBeVisible();
  for (const t of ["light", "dark"] as const) {
    await theme(page, t);
    await shot(page, `fleet-${t}`);
    expect(await axe(page)).toEqual([]);
  }
  await theme(page, "light");
  await page.getByRole("button", { name: /Problems their LUME reported/ }).click();
  await expect(list.getByRole("link")).toHaveCount(3);
  await saffron.click();
  const card = page.getByRole("region", { name: "Health" });
  await expect(card).toContainText("The server’s disk is almost full: 4% free.");
  await expect(card.getByRole("img", { name: /Disk free over \d+ days/ })).toBeVisible();
  await shot(page, "fleet-client");
  expect(await axe(page)).toEqual([]);

  await page.goto("/fleet?tab=announcements");
  await page.getByRole("button", { name: "New announcement" }).click();
  const sheet = page.getByRole("dialog", { name: "New announcement" });
  await sheet.getByRole("radio", { name: "Maintenance" }).click();
  const at = (d: number, h: number) => {
    const x = new Date(Date.now() + d * 86_400_000);
    x.setHours(h, 0, 0, 0);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}T${String(h).padStart(2, "0")}:00`;
  };
  await sheet.getByLabel("Maintenance starts").fill(at(2, 22));
  await sheet.getByLabel("Ends").fill(at(2, 23));
  await sheet.getByLabel("Title").fill("LUME will be updated on Sunday night");
  await sheet
    .getByLabel("Message")
    .fill("LUME will be away for about 30 minutes while it’s updated. Nothing you’ve saved is touched.");
  await sheet.getByRole("radio", { name: "Admins only" }).click();
  await shot(page, "announce-new");
  expect(await axe(page)).toEqual([]);
  await sheet.getByRole("button", { name: "Publish" }).click();
  await expect(sheet).toBeHidden();
  const head = page.getByRole("button", { name: /LUME will be updated on Sunday night/ });
  await expect(head).toContainText("Admins at all clients");
  await expect(head).toContainText(/Reached 0 of \d+/);
  await shot(page, "announce-list");
  expect(await axe(page)).toEqual([]);
  await head.click();
  await page.getByRole("button", { name: "Withdraw…" }).click();
  await page.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(page.getByRole("button", { name: /LUME will be updated on Sunday night/ })).toContainText(
    "Withdrawn",
  );
  // The client's history says so.
  await page.goto(`/clients/${seed().ids["Brightpath Studio"]}`);
  await expect(page.getByRole("region", { name: "History" })).toContainText(
    "Announcement withdrawn: LUME will be updated on Sunday night",
  );
});

test("Plan limits: places and a module left out, the warning, Save, and the history — both themes", async () => {
  await theme(page, "light");
  await page.goto(`/clients/${seed().ids["Lotus Wellness"]}`);
  const card = page.getByRole("region", { name: "Plan limits" });
  await expect(card.getByRole("radio", { name: "No limit" })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
  await card.getByRole("radio", { name: "A number" }).click();
  await card.getByRole("button", { name: "One more" }).click();
  await card.getByRole("switch", { name: "Webhooks in their plan" }).click();
  await expect(card).toContainText(
    "On at Lotus Wellness now — switching it off stops it at their next check-in.",
  );
  await card.scrollIntoViewIfNeeded();
  for (const t of ["light", "dark"] as const) {
    await theme(page, t);
    await card.screenshot({ path: `e2e/__review__/plan-limits-${t}.png`, animations: "disabled" });
    expect(await axe(page)).toEqual([]);
  }
  await theme(page, "light");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("Saved. Their LUME keeps it from its next check-in, within 6 hours.");
  await expect(page.getByRole("region", { name: "History" })).toContainText(
    /Plan: \d+ places; Webhooks not included/,
  );
  // Kept: the page again, the same.
  await page.reload();
  await expect(card.getByRole("radio", { name: "A number" })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByRole("switch", { name: "Webhooks in their plan" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
});
