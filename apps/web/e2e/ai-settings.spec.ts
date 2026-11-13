import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { callApi, expect, openApp, reviewCopy, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/**
 * Autopilot A1 end to end (plan 2026-10-20, Task 7): LUME AI's month and its ring, a top-up asked for and added through
 * the licence fake, and Settings → LUME AI saved and read back. Against the fake AI provider; never a real model.
 */
const FAKE = "http://127.0.0.1:3113/__fake";
const all = {
  googleSheets: true,
  webhooks: true,
  googleCalendar: true,
  calendly: true,
  ai: true,
  whatsapp: true,
};

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
async function licenceSays(page: Page, says: Record<string, unknown>) {
  expect((await page.request.post(`${FAKE}/state`, { data: says })).ok()).toBeTruthy();
  const c = await callApi(page, "POST", "/api/v1/licence/check");
  expect(c.status, JSON.stringify(c.data)).toBe(200);
}
const switchAi = async (page: Page, enabled: boolean) => {
  const r = await callApi(page, "PUT", "/api/v1/integrations/ai", { enabled });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
};
/** This month on the business's clock, as the licence counts it ("2026-10"). */
async function monthKey(page: Page): Promise<string> {
  const s = await callApi<{ timezone: string }>(page, "GET", "/api/v1/settings");
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: s.data.timezone, year: "numeric", month: "2-digit" })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((a, x) => ({ ...a, [x.type]: x.value }), {});
  return `${p.year}-${p.month}`;
}
/** A file for Media, through the same upload the Media page uses. */
async function upload(page: Page, name: string, text: string): Promise<string> {
  return page.evaluate(
    async ({ name, text }) => {
      const { token } = await (await fetch("/api/v1/auth/csrf")).json();
      const r = await fetch("/api/v1/files", {
        method: "POST",
        headers: {
          "x-csrf-token": token,
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(name),
        },
        body: new TextEncoder().encode(text),
      });
      return ((await r.json()) as { file: { id: string } }).file.id;
    },
    { name, text },
  );
}
const ring = (page: Page) => page.getByRole("button", { name: /^LUME AI: / });
/**
 * Clear the LUME AI notices this spec caused (its 80% month sends admins a real one), and only those: later specs'
 * bells and their screenshots must not carry them (the notification centre's did, 2026-10-23). "Clear read" clears
 * every read notification, so any other it took is put back.
 */
async function clearOurNotices(page: Page) {
  const list = await callApi<{ items: { id: number; title: string }[] }>(
    page,
    "GET",
    "/api/v1/notifications",
  );
  // Someone LUME won't serve yet (the invited admin before their welcome and agreement, which onboarding.spec does
  // later) has nothing on a screen before then: leave theirs.
  if (list.status !== 200) return;
  const ours = list.data.items.filter((n) => n.title.startsWith("LUME AI has")).map((n) => n.id);
  if (!ours.length) return;
  await callApi(page, "POST", "/api/v1/notifications/read", { ids: ours });
  const cleared = await callApi<{ cleared: number[] }>(page, "POST", "/api/v1/notifications/clear-read");
  const others = cleared.data.cleared.filter((id) => !ours.includes(id));
  if (others.length) await callApi(page, "POST", "/api/v1/notifications/clear-read/undo", { ids: others });
}
const leads: string[] = [];
const files: string[] = [];

test.describe("LUME AI's month, and Settings → LUME AI", () => {
  test.use({ storageState: stateFile("owner") });

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/today");
    await switchAi(page, true);
    await page.request.delete(`${FAKE}/topups`);
    await ctx.close();
  });
  // Leave the workspace as it was: LUME AI off, no plan from the fake, the leads gone and the files archived.
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await openApp(page, "/today");
    await switchAi(page, false);
    await licenceSays(page, {});
    if (leads.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: leads, action: { type: "delete" } });
    for (const id of files) await callApi(page, "POST", `/api/v1/files/${id}/archive`);
    await clearOurNotices(page);
    await ctx.close();
    // The month's notices go to every admin. The admin may not have finished their welcome yet (onboarding.spec runs
    // later), so not the app's shell: any address on the app's origin will do for its API.
    const admin = await browser.newContext({ storageState: stateFile("admin") });
    const adminPage = await admin.newPage();
    await adminPage.goto("/api/v1/auth/csrf");
    await clearOurNotices(adminPage);
    await admin.close();
  });

  test("AI leads: the ring fills, turns amber at 80%, says when they're used up, asks for a top-up once, and falls back when it's added", async ({
    page,
  }) => {
    await openApp(page, "/today");
    const used = (await callApi<{ leads: { used: number } }>(page, "GET", "/api/v1/ai")).data.leads.used;
    // A small allowance (owner's spec 2026-11-12): five AI leads left this month.
    const plan = { places: null, modules: all, aiReadsHourly: null, aiLeadsMonthly: used + 5 };
    await licenceSays(page, { plan: { ...plan, aiLeadTopUps: [] } });
    const ours: string[] = [];
    for (const name of [
      "Meera Iyer",
      "Rohan Gupta",
      "Anika Rao",
      "Kabir Shah",
      "Isha Menon",
      "Arjun Mehta",
    ]) {
      const id = (await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", { name })).data.lead
        .id;
      leads.push(id);
      ours.push(id);
    }
    // Four leads caught up: four AI leads, however many times each is asked.
    for (const id of ours.slice(0, 4)) {
      const r = await callApi(page, "POST", `/api/v1/leads/${id}/ai/catch-up`);
      expect(r.status, JSON.stringify(r.data)).toBe(200);
    }
    await callApi(page, "POST", `/api/v1/leads/${ours[0]}/ai/catch-up`);
    const n = (x: number) => x.toLocaleString("en-US");

    await openApp(page, "/today");
    await expect(ring(page)).toHaveAccessibleName(
      `LUME AI: ${n(used + 4)} of ${n(used + 5)} AI leads used this month`,
    );
    await expect(ring(page).locator('[data-tone="amber"]')).toHaveCount(1);
    await ring(page).click();
    const panel = page.getByRole("dialog", { name: "LUME AI this month" });
    await expect(panel).toContainText(`${n(used + 4)} of ${n(used + 5)} AI leads used this month`);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      expect(await axe(page)).toEqual([]);
      await reviewCopy(panel, `ring-amber-${theme}.png`);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.keyboard.press("Escape");

    // The fifth uses the last one; the sixth lead can't start, while a counted one still gets its catch-up.
    expect((await callApi(page, "POST", `/api/v1/leads/${ours[4]}/ai/catch-up`)).status).toBe(200);
    const sixth = await callApi<{ unavailable?: string }>(
      page,
      "POST",
      `/api/v1/leads/${ours[5]}/ai/catch-up`,
    );
    expect(sixth.data.unavailable).toBe("leads");
    const again = await callApi<{ read?: unknown }>(page, "POST", `/api/v1/leads/${ours[1]}/ai/catch-up`);
    expect(again.data.read).toBeTruthy();

    await openApp(page, "/today");
    await expect(ring(page)).toHaveAccessibleName("LUME AI: this month's AI leads are used up");
    await ring(page).click();
    await expect(panel).toContainText(
      "This month's AI leads are used up. Leads LUME AI is already working on carry on",
    );
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      expect(await axe(page)).toEqual([]);
      await reviewCopy(panel, `ring-full-${theme}.png`);
    }
    await page.emulateMedia({ colorScheme: "light" });

    await panel.getByRole("button", { name: "Ask for a top-up of 100 AI leads" }).click();
    await expect(panel).toContainText("Asked. LUME will let you know when it's added.");
    await expect(panel.getByRole("button", { name: /^Ask/ })).toHaveCount(0);
    // Asked again (another admin, or the API twice): still one request reaches the owner.
    await callApi(page, "POST", "/api/v1/ai/topup", {});
    const month = await monthKey(page);
    const asked = (await (await page.request.get(`${FAKE}/topups`)).json()) as {
      topUps: { month: string }[];
    };
    expect(asked.topUps.filter((t) => t.month === month)).toHaveLength(1);

    // The owner adds a pack of 100 for this month: the ring falls back at the next check-in, and the sixth starts.
    await licenceSays(page, { plan: { ...plan, aiLeadTopUps: [{ month, leads: 100 }] } });
    await openApp(page, "/today");
    await expect(ring(page)).toHaveAccessibleName(
      `LUME AI: ${n(used + 5)} of ${n(used + 105)} AI leads used this month`,
    );
    await expect(ring(page).locator('[data-tone="amber"]')).toHaveCount(0);
    expect((await callApi(page, "POST", `/api/v1/leads/${ours[5]}/ai/catch-up`)).status).toBe(200);
  });

  test("Settings → LUME AI: prices, a question, two files, Careful then one row changed; all kept after a reload", async ({
    page,
  }) => {
    await openApp(page, "/today");
    files.push(await upload(page, "Brochure.txt", "Brightpath Interiors. Kitchens, wardrobes, whole homes."));
    files.push(await upload(page, "Rates 2026.txt", "Modular kitchen from 3,80,000. Design visit 1,150.50."));
    await openApp(page, "/settings/ai");
    await expect(page.getByRole("heading", { name: "LUME AI", level: 1 })).toBeVisible();

    const knows = page.getByRole("region", { name: "What LUME AI knows" });
    const rows: [string, string, string][] = [
      ["Modular kitchen", "3,80,000", "per kitchen"],
      ["Design visit", "1150.50", "per visit"],
      ["Wardrobe", "95,000", "per wardrobe"],
    ];
    for (const [i, [item, amount, unit]] of rows.entries()) {
      await knows.getByRole("button", { name: "Add a price" }).click();
      await knows.getByRole("textbox", { name: `What price ${i + 1} is for` }).fill(item);
      await knows.getByRole("textbox", { name: `Price for ${item}` }).fill(amount);
      await knows.getByRole("textbox", { name: `Unit for ${item}` }).fill(unit);
    }
    await knows.getByRole("button", { name: "Add a question" }).click();
    await knows.getByRole("textbox", { name: "Question 1" }).fill("Do you visit before quoting?");
    await knows.getByRole("textbox", { name: "Answer 1" }).fill("Yes, a free site visit within the city.");
    await knows.getByRole("button", { name: "Choose from Media" }).click();
    const media = page.getByRole("listbox", { name: "Media" });
    await media.getByRole("option", { name: /^Brochure\.txt/ }).click();
    await media.getByRole("option", { name: /^Rates 2026\.txt/ }).click();
    await page.getByRole("button", { name: "Attach 2 files" }).click();
    await expect(
      knows.getByRole("list", { name: "Files LUME AI may send" }).getByRole("listitem"),
    ).toHaveCount(2);
    await knows.getByRole("button", { name: "Save what LUME AI knows" }).click();
    await expect(knows.getByRole("status")).toHaveText("Saved");

    const standing = page.getByRole("region", { name: "Standing choices" });
    await standing.getByRole("button", { name: /^Careful/ }).click();
    await standing
      .getByRole("radiogroup", { name: "Mark a lead lost" })
      .getByRole("radio", { name: "Ask me" })
      .click();
    for (const p of ["Careful", "Balanced", "Hands-off"])
      await expect(standing.getByRole("button", { name: new RegExp(`^${p}`) })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    await standing.getByRole("button", { name: "Save standing choices" }).click();
    await expect(standing.getByRole("status")).toHaveText("Saved");

    await page.reload();
    // Each kept exactly, and shown grouped the way the business currency reads (lakh grouping for INR).
    const saved = await callApi<{ currency: string; profile: { knows: { prices: { price: number }[] } } }>(
      page,
      "GET",
      "/api/v1/ai/profile",
    );
    const currency = saved.data.currency;
    const shown = (v: number) =>
      v.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: 2 });
    await expect(page.getByRole("textbox", { name: "Price for Modular kitchen" })).toHaveValue(shown(380000));
    await expect(page.getByRole("textbox", { name: "Price for Design visit" })).toHaveValue(shown(1150.5));
    await expect(page.getByRole("textbox", { name: "Price for Wardrobe" })).toHaveValue(shown(95000));
    expect(saved.data.profile.knows.prices.map((p) => p.price)).toEqual([380000, 1150.5, 95000]);
    await expect(page.getByRole("textbox", { name: "Question 1" })).toHaveValue(
      "Do you visit before quoting?",
    );
    const chosen = page.getByRole("list", { name: "Files LUME AI may send" });
    await expect(chosen.getByRole("listitem", { name: "Brochure.txt" })).toBeVisible();
    await expect(chosen.getByRole("listitem", { name: "Rates 2026.txt" })).toBeVisible();
    await expect(
      page.getByRole("radiogroup", { name: "Mark a lead lost" }).getByRole("radio", { name: "Ask me" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByRole("radiogroup", { name: "Answer price questions" }).getByRole("radio", { name: "Never" }),
    ).toHaveAttribute("aria-checked", "true");

    // Tall enough that each section is on screen whole: the app scrolls inside its own frame, and a section past the
    // window's bottom comes out unpainted in a screenshot.
    await page.setViewportSize({ width: 1280, height: 2600 });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      expect(await axe(page)).toEqual([]);
      await reviewCopy(page.getByRole("region", { name: "What LUME AI knows" }), `knows-${theme}.png`);
      await reviewCopy(page.getByRole("region", { name: "Voice" }), `voice-${theme}.png`);
      await reviewCopy(page.getByRole("region", { name: "Standing choices" }), `standing-${theme}.png`);
      await reviewCopy(page.getByRole("region", { name: "Usage" }), `usage-${theme}.png`);
    }
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("unsaved changes ask before LUME leaves the page; nothing changed, it just goes", async ({ page }) => {
    await openApp(page, "/settings/ai");
    await page.getByRole("textbox", { name: "About your business" }).fill("We design homes and offices.");
    await page.getByRole("link", { name: "Leads", exact: true }).first().click();
    const sheet = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect(sheet).toBeVisible();
    await reviewCopy(sheet, "leave-sheet.png");
    await sheet.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(/\/settings\/ai$/);
    await expect(page.getByRole("textbox", { name: "About your business" })).toHaveValue(
      "We design homes and offices.",
    );

    await page.getByRole("link", { name: "Leads", exact: true }).first().click();
    await page
      .getByRole("dialog", { name: "Leave without saving?" })
      .getByRole("button", { name: "Leave without saving" })
      .click();
    await expect(page).toHaveURL(/\/leads/);
  });

  test("on a phone: one column, and each action's three choices full width under it", async ({ browser }) => {
    const ctx = await browser.newContext({
      storageState: stateFile("owner"),
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await openApp(page, "/settings/ai");
    const standing = page.getByRole("region", { name: "Standing choices" });
    const group = standing.getByRole("radiogroup", { name: "Book meetings" });
    const words = standing.getByText("Book meetings", { exact: true });
    const g = (await group.boundingBox())!;
    const w = (await words.boundingBox())!;
    expect(g.y).toBeGreaterThan(w.y + w.height - 1);
    const panel = (await standing.boundingBox())!;
    expect(g.width).toBeGreaterThan(panel.width * 0.7);
    // Nothing runs off the side of the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await reviewCopy(page, "phone.png");
    await standing.scrollIntoViewIfNeeded();
    await reviewCopy(standing, "phone-standing.png");
    await ctx.close();
  });
});
