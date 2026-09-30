import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** The seeded admin (prepare.ts) and each client's id. */
const seed = () =>
  JSON.parse(readFileSync(new URL("./.artifacts/admin.json", import.meta.url), "utf8")) as {
    email: string;
    password: string;
    secret: string;
    ids: Record<string, string>;
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

test("a client's actions, end to end: New licence, Mark paid, the reminder, Rotate, Suspend", async () => {
  await theme(page, "light");
  await page.goto("/clients");
  await page.getByRole("button", { name: "New licence" }).click();
  const sheet = page.getByRole("dialog", { name: "New licence" });
  await sheet.getByLabel("Business name").fill("Palm Bay Clinic");
  await sheet.getByLabel("Country").selectOption("AE");
  await sheet.getByLabel("City", { exact: true }).fill("Dubai");
  await sheet.getByLabel("Price").fill("450");
  await sheet.getByRole("button", { name: "Create licence" }).click();
  const done = page.getByRole("dialog", { name: "Licence created" });
  await expect(done).toContainText(/LUME(-[0-9A-Z]{4}){5}/);
  await shot(page, "licence-created");
  await done.getByRole("link", { name: "Open Palm Bay Clinic" }).click();
  await expect(page.getByRole("heading", { name: "Palm Bay Clinic" })).toBeVisible();

  await page.getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByRole("status")).toContainText("Paid until");
  await page.getByRole("button", { name: "Send payment reminder" }).click();
  await page.getByRole("button", { name: "Send reminder" }).click();
  await expect(page.getByText("Reminder on.")).toBeVisible();
  await page.getByRole("button", { name: "Rotate key" }).click();
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
  await page.getByRole("button", { name: "Suspend…" }).click();
  await page.getByRole("button", { name: "Suspend", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await shot(page, "client-after-actions");
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Suspend…" })).toBeVisible();
});
