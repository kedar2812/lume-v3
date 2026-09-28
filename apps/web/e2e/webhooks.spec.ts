import AxeBuilder from "@axe-core/playwright";
import { createHmac } from "node:crypto";
import type { Page } from "@playwright/test";
import { callApi, expect, openApp, stateFile, test } from "./fixtures";
import { settle } from "./settle";

/** Post as a sender would: signed over "<timestamp>.<body>" (2C spec §2), or with a wrong secret. */
async function send(address: string, secret: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `sha256=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`;
  return fetch(address, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lume-timestamp": ts, "x-lume-signature": sig },
    body: raw,
  });
}
async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
const leadsNamed = (page: Page, q: string) =>
  callApi<{ items: { id: string; name: string }[] }>(
    page,
    "GET",
    `/api/v1/leads?q=${encodeURIComponent(q)}`,
  ).then((r) => r.data.items);

test.describe("Webhooks", () => {
  // Leave the workspace as it was: later specs' approved screenshots must not see these leads.
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await page.goto("/leads");
    const { sources } = (
      await callApi<{ sources: { id: string }[] }>(page, "GET", "/api/v1/webhooks/sources")
    ).data ?? { sources: [] };
    for (const s of sources) {
      for (;;) {
        const { items } = (
          await callApi<{ items: { id: string }[] }>(page, "GET", `/api/v1/leads?source=${s.id}&limit=100`)
        ).data;
        if (!items.length) break;
        await callApi(page, "POST", "/api/v1/leads/bulk", {
          ids: items.map((l) => l.id),
          action: { type: "delete" },
        });
      }
      await callApi(page, "DELETE", `/api/v1/webhooks/sources/${s.id}`);
    }
    await callApi(page, "PUT", "/api/v1/integrations/webhooks", { enabled: false });
    await ctx.close();
  });

  test("a signed post becomes a lead through the usual steps; a forged one is refused and counted", async ({
    page,
  }) => {
    await openApp(page, "/leads"); // seen now: what arrives from here on glows
    await openApp(page, "/settings/integrations");
    const sw = page.getByRole("switch", { name: "Webhooks" });
    if ((await sw.getAttribute("aria-checked")) === "false") await sw.click();
    await page.getByRole("button", { name: "Add a webhook" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a webhook" });
    await dialog.getByRole("radio", { name: /Website form/ }).check();
    await dialog.getByLabel("Name").fill("Landing page form");
    await dialog.getByRole("button", { name: "Create webhook" }).click();
    await expect(dialog.getByText("LUME won't show this again. Copy it now.")).toBeVisible();
    // The codes and the sample carry this run's address and secret: masked, so the shot is stable.
    await expect(dialog).toHaveScreenshot("webhook-secret-step.png", {
      mask: [dialog.locator("code"), dialog.getByLabel("Code sample")],
    });
    const [address, secret] = await dialog.locator("code").allTextContents();
    expect(address).toMatch(/\/webhooks\/in\/[0-9a-f-]{36}$/);
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(dialog.getByText("Waiting for the first post…")).toBeVisible();

    const test1 = {
      name: "Webhook Lead One",
      contact: { phone: "+971503001001" },
      email: "one@example.test",
    };
    expect((await send(address!, secret!, test1)).status).toBe(202);
    await expect(dialog.getByRole("list", { name: "What the post sent" })).toContainText("contact.phone");
    await dialog.getByRole("button", { name: "Use this post" }).click();
    await dialog.getByRole("button", { name: "Continue" }).click(); // Columns
    await dialog.getByRole("button", { name: "Continue" }).click(); // Rules
    await dialog.getByRole("button", { name: "Continue" }).click(); // Preview
    await expect(dialog.getByRole("checkbox", { name: "Keep the test post as a lead" })).toBeChecked();
    await dialog.getByRole("button", { name: "Turn it on" }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => (await leadsNamed(page, "Webhook Lead One")).length, { timeout: 15_000 })
      .toBe(1);
    await openApp(page, "/leads?q=Webhook%20Lead");
    await expect(page.locator("tr[data-arrived]").filter({ hasText: "Webhook Lead One" })).toBeVisible();

    // The same person again: one lead, and its history says they enquired again.
    const again = {
      name: "Webhook Lead One",
      contact: { phone: "+971503001001" },
      email: "one+2@example.test",
    };
    expect((await send(address!, secret!, again)).status).toBe(202);
    const [lead] = await leadsNamed(page, "Webhook Lead One");
    await expect
      .poll(
        async () =>
          (
            await callApi<{ items: { type: string }[] }>(page, "GET", `/api/v1/leads/${lead!.id}/activities`)
          ).data.items.map((a) => a.type),
        { timeout: 15_000 },
      )
      .toContain("imported_again");
    expect(await leadsNamed(page, "Webhook Lead One")).toHaveLength(1);

    // A forged post: refused, nothing kept, and the page counts it.
    expect((await send(address!, "x".repeat(43), { name: "Forged Lead" })).status).toBe(401);
    const id = address!.split("/").at(-1)!;
    await openApp(page, `/settings/integrations/webhooks/${id}`);
    await expect(page.getByText(/1 refused · last for a bad signature/)).toBeVisible();
    await expect(page.getByRole("table", { name: "Recent posts" })).toContainText("New lead");
    expect(await leadsNamed(page, "Forged Lead")).toHaveLength(0);
  });

  test("screenshots and axe: the Webhooks card and a webhook's page — both themes", async ({ page }) => {
    await openApp(page, "/settings/integrations");
    const { sources } = (
      await callApi<{ sources: { id: string }[] }>(page, "GET", "/api/v1/webhooks/sources")
    ).data;
    const id = sources[0]!.id;
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/settings/integrations");
      const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Webhooks" }) });
      await expect(card.getByRole("link", { name: /Landing page form/ })).toBeVisible();
      await expect(card).toHaveScreenshot(`webhooks-card-${theme}.png`, {
        mask: [card.getByText(/^Last post/)],
      });
      expect(await axe(page)).toEqual([]);
      await openApp(page, `/settings/integrations/webhooks/${id}`);
      await expect(page.getByRole("table", { name: "Recent posts" })).toBeVisible();
      await expect(page.locator("main")).toHaveScreenshot(`webhook-page-${theme}.png`, {
        mask: [page.locator("td:first-child"), page.locator("dd").first(), page.locator("code")],
      });
      expect(await axe(page)).toEqual([]);
    }
  });
});
