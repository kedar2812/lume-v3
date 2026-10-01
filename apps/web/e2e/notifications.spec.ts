import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { forgetDigests } from "./db";
import {
  PEOPLE,
  callApi,
  expect,
  freezeVolatile,
  openApp,
  reviewCopy,
  stateFile,
  test,
  type Mail,
} from "./fixtures";
import { settle } from "./settle";

const MAIL_API = `http://127.0.0.1:${process.env.E2E_MAIL_API_PORT ?? 3111}/messages`;
const H = 3_600_000;

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
const made: string[] = [];
async function lead(page: Page, body: Record<string, unknown>): Promise<string> {
  const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", body);
  made.push(r.data.lead.id);
  return r.data.lead.id;
}
async function personId(page: Page, name: string): Promise<string> {
  const { people } = (
    await callApi<{ people: { id: string; name: string }[] }>(page, "GET", "/api/v1/people")
  ).data;
  return people.find((p) => p.name === name)!.id;
}
const volatile = (page: Page) => [page.locator("[data-volatile]")];

test.describe("Notifications (3B)", () => {
  // The workspace as it was: escalation back to a day, and the leads (with their follow-ups) gone.
  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: stateFile("owner") });
    const page = await ctx.newPage();
    await page.goto("/leads");
    await callApi(page, "PUT", "/api/v1/settings/follow-ups", { escalation: { enabled: true, hours: 24 } });
    if (made.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made, action: { type: "delete" } });
    await ctx.close();
  });

  test("an overdue follow-up reaches the owner, set in Settings → Follow-ups; the centre by keyboard", async ({
    page,
  }) => {
    await openApp(page, "/leads");
    const noor = await personId(page, PEOPLE.seller.name);
    const theirs = await lead(page, { name: "Late Lead", ownerId: noor });
    await callApi(page, "POST", `/api/v1/leads/${theirs}/tasks`, {
      title: "Send the quote",
      assigneeId: noor,
      due: { at: new Date(Date.now() - 3 * H).toISOString() },
    });
    const mine = await lead(page, { name: "Own Late" });
    await callApi(page, "POST", `/api/v1/leads/${mine}/tasks`, {
      title: "Call back",
      due: { at: new Date(Date.now() - 2 * H).toISOString() },
    });

    // Settings → Follow-ups: tell managers after an hour, not a day.
    await openApp(page, "/settings/follow-ups");
    const hours = page.getByLabel("After how many hours");
    await expect(hours).toHaveValue("24");
    await hours.fill("1");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("main").getByRole("status")).toHaveText("Saved");
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await reviewCopy(page.locator("main"), `settings-follow-ups-${theme}.png`);
      await expect(page.locator("main")).toHaveScreenshot(`settings-follow-ups-${theme}.png`, {
        mask: [page.locator("[data-live-count]")],
      });
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });

    // The escalation arrives live: the bell lights without a reload.
    await openApp(page, "/leads");
    await expect(page.getByRole("button", { name: /^Notifications, \d+ unread$/ })).toBeVisible({
      timeout: 60_000,
    });

    // "." opens the centre; the escalation is there with Remind them.
    await page.keyboard.press(".");
    const centre = page.getByRole("dialog", { name: "Notifications" });
    await expect(centre).toBeVisible();
    const escalation = centre.getByRole("listitem", {
      name: /Noor's follow-up with Late Lead is 3 h overdue/,
    });
    await expect(escalation).toBeVisible();
    await expect(centre.getByRole("list", { name: "Overdue" })).toContainText("Own Late");

    // The full copies first, both themes, before anything is frozen for the baselines.
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(centre, `centre-${theme}.png`);
    }
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await freezeVolatile(page);
      await expect(centre).toHaveScreenshot(`centre-${theme}.png`, { mask: volatile(page) });
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });

    // F: full screen, and Esc steps back before it closes.
    await page.keyboard.press("f");
    await expect(centre).toHaveAttribute("data-full");
    await reviewCopy(page, "centre-full-light.png");
    await page.keyboard.press("Escape");
    await expect(centre).not.toHaveAttribute("data-full");
    await expect(centre).toBeVisible();

    // J to your own overdue follow-up, E to finish it.
    const own = centre.getByRole("listitem", { name: /^Own Late/ });
    await page.keyboard.press("j");
    await expect(own).toBeFocused();
    await page.keyboard.press("e");
    await expect(own).toBeHidden();

    // Remind them nudges Noor; Mark all read puts the bell out.
    await escalation.getByRole("button", { name: "Remind them" }).click();
    await expect(escalation).toContainText("Reminded");
    await centre.getByRole("button", { name: "Mark all read" }).click();
    await page.keyboard.press("Escape");
    await expect(centre).toBeHidden();
    await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
  });

  test("the morning email: the day ahead with first names and times, and no contact details", async ({
    page,
    browser,
  }) => {
    // The owner gives Noor a lead with a phone and an email, and a follow-up on it.
    await openApp(page, "/leads");
    const noor = await personId(page, PEOPLE.seller.name);
    const id = await lead(page, {
      name: "Digest Person",
      phone: "+971 50 123 4567",
      email: "digest.person@example.test",
      ownerId: noor,
    });
    // Overdue by half an hour, so it's in the email whatever the time of day the run happens.
    await callApi(page, "POST", `/api/v1/leads/${id}/tasks`, {
      title: "Call back",
      assigneeId: noor,
      due: { at: new Date(Date.now() - 0.5 * H).toISOString() },
    });

    // Noor asks for it every day, from midnight: the next run sends it (today's earlier one, if any, is forgotten).
    await forgetDigests(PEOPLE.seller.email);
    const since = new Date().toISOString();
    const ctx = await browser.newContext({ storageState: stateFile("seller") });
    const theirs = await ctx.newPage();
    await openApp(theirs, "/today");
    const r = await callApi(theirs, "PATCH", "/api/v1/me", {
      preferences: { digestTime: "00:00", workingDays: [0, 1, 2, 3, 4, 5, 6] },
    });
    expect(r.status).toBe(200);

    let mail: Mail | undefined;
    await expect
      .poll(
        async () => {
          const all = (await (await page.request.get(MAIL_API)).json()) as Mail[];
          mail = all.filter((m) => m.to.includes(PEOPLE.seller.email) && m.at > since).at(-1);
          return mail?.subject ?? "";
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toMatch(/follow-up/);
    // Its greeting follows the hour on Noor's clock (a run can fall at any time of day).
    expect(mail!.text).toMatch(/Good (morning|afternoon|evening), Noor\./);
    expect(mail!.text).toContain("Digest: Call back");
    expect(mail!.text).not.toContain("Digest Person"); // first names only
    expect(mail!.text).not.toMatch(/123 ?4567|digest\.person@/);
    await ctx.close();
  });
});
