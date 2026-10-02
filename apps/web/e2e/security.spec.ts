import AxeBuilder from "@axe-core/playwright";
import type { Browser, Page } from "@playwright/test";
import {
  agreeToTerms,
  alertIn,
  callApi,
  expect,
  hydrated,
  lastMailTo,
  linkIn,
  openApp,
  reviewCopy,
  stateFile,
  test,
} from "./fixtures";
import { settle } from "./settle";

/**
 * The watch (6A) on the real stack, the report's test at a small scale: a Sales person reveals contacts past
 * the limit (set to 5 here, for speed), is stopped at the reveal that crosses it and paused; the owner sees the
 * alert arrive live, reviews it and restores them; they sign in again. The person is made by this spec, so no
 * other spec's people are paused.
 */
const RORY = { email: "rory@brightpath.test", name: "Rory Reid", password: "sunrise over the creek at five" };
const RULES = (reveals: { action: string; threshold: number }) => ({
  anomaly: {
    reveals,
    leadsOpened: { action: "suspend", threshold: 200 },
    queueRuns: { action: "alert", threshold: 3 },
  },
  watermark: "masked_roles",
});

async function axe(page: Page) {
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
async function asOwner(browser: Browser, theme: "light" | "dark" = "light") {
  const ctx = await browser.newContext({ storageState: stateFile("owner"), colorScheme: theme });
  return { ctx, page: await ctx.newPage() };
}
async function signIn(page: Page, who = RORY) {
  await page.goto("/sign-in");
  await hydrated(page);
  await page.getByLabel("Email").fill(who.email);
  await page.getByRole("textbox", { name: "Password" }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe.configure({ mode: "serial" });

test.describe("The watch (6A)", () => {
  const leads: string[] = [];

  test.afterAll(async ({ browser }) => {
    const { ctx, page } = await asOwner(browser);
    await openApp(page, "/today");
    await callApi(page, "PUT", "/api/v1/security/settings", RULES({ action: "suspend", threshold: 30 }));
    if (leads.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: leads, action: { type: "delete" } });
    await ctx.close();
  });

  test("a burst is stopped at the line; the owner hears at once, reviews and restores", async ({
    browser,
    page,
  }) => {
    // Rory joins as Sales, with two leads of his own; the rule pauses past 5 contacts in an hour.
    await openApp(page, "/today");
    const roles = (
      await callApi<{ roles: { id: string; name: string }[] }>(page, "GET", "/api/v1/roles/assignable")
    ).data.roles;
    const since = new Date(Date.now() - 1000).toISOString();
    expect(
      (
        await callApi(page, "POST", "/api/v1/invites", {
          email: RORY.email,
          name: RORY.name,
          roleIds: [roles.find((r) => r.name === "Sales")!.id],
        })
      ).status,
    ).toBe(201);
    const rory = await browser.newContext();
    const rp = await rory.newPage();
    await rp.goto(linkIn(await lastMailTo(page.request, RORY.email, since), "invite"));
    await hydrated(rp);
    await rp.getByLabel("Choose a password").fill(RORY.password);
    await rp.getByRole("button", { name: "Join LUME" }).click();
    await agreeToTerms(rp);
    await callApi(rp, "PUT", "/api/v1/me/onboarding", { completed: true });
    await callApi(rp, "PUT", "/api/v1/me/tour", { skipped: true });
    const people = (await callApi<{ people: { id: string; name: string }[] }>(page, "GET", "/api/v1/people"))
      .data.people;
    const roryId = people.find((p) => p.name === RORY.name)!.id;
    for (const [name, phone] of [
      ["Dana Whitfield", "+971501112233"],
      ["Lina Rahim", "+971502223344"],
    ] as const) {
      const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", {
        name,
        phone,
        ownerId: roryId,
      });
      leads.push(r.data.lead.id);
    }
    expect(
      (await callApi(page, "PUT", "/api/v1/security/settings", RULES({ action: "suspend", threshold: 5 })))
        .status,
    ).toBe(200);

    // The owner is on the leads list when it happens.
    await openApp(page, "/leads");

    // Rory sees his lead with his own watermark; three reveals, then a fourth from the drawer: the quiet notice.
    for (const theme of ["light", "dark"] as const) {
      await rp.emulateMedia({ colorScheme: theme });
      await openApp(rp, `/leads?lead=${leads[0]}`);
      await expect(rp.locator("[data-watermark]")).toHaveAttribute(
        "data-watermark",
        /^Rory Reid · rory@brightpath\.test · /,
      );
      await settle(rp);
      await reviewCopy(rp, `rep-lead-watermark-${theme}.png`);
    }
    await rp.emulateMedia({ colorScheme: "light" });
    for (let i = 0; i < 3; i++)
      expect((await callApi(rp, "POST", `/api/v1/leads/${leads[1]}/contact/reveal`)).status).toBe(200);
    await openApp(rp, `/leads?lead=${leads[0]}`);
    const drawer = rp.getByRole("dialog", { name: "Dana Whitfield" });
    await drawer.getByRole("button", { name: "Reveal contact" }).click();
    await expect(drawer.getByRole("note")).toContainText("You’ve opened a lot of contacts this hour");
    await expect(drawer.getByRole("note")).not.toContainText(/\d/);
    await settle(rp);
    await reviewCopy(rp, "rep-near-limit-light.png");
    expect(await axe(rp)).toEqual([]);

    // The fifth is shown; the sixth crosses the line: refused, and from then on Rory is paused.
    expect((await callApi(rp, "POST", `/api/v1/leads/${leads[1]}/contact/reveal`)).status).toBe(200);
    const sixth = await callApi<{ error: { code: string } }>(
      rp,
      "POST",
      `/api/v1/leads/${leads[1]}/contact/reveal`,
    );
    expect(sixth.status).toBe(403);
    expect(sixth.data.error.code).toBe("SUSPENDED");
    await rp.goto("/leads");
    await expect(rp).toHaveURL(/\/sign-in\?paused=1$/);
    await expect(rp.getByRole("heading", { name: "Your access is paused" })).toBeVisible();
    await reviewCopy(rp, "rep-paused-light.png");
    expect(await axe(rp)).toEqual([]);
    // Signing in again says the same, and makes no session.
    await rp.getByRole("button", { name: "Back to sign in" }).click();
    await signIn(rp);
    await expect(rp.getByRole("heading", { name: "Your access is paused" })).toBeVisible();

    // The owner heard at once: the HUD rises with Review.
    const hud = page.getByRole("status").filter({ hasText: "LUME paused Rory Reid’s access" });
    await expect(hud).toBeVisible({ timeout: 15_000 });
    await reviewCopy(page, "owner-hud-light.png");
    await hud.getByRole("button", { name: "Review" }).click();
    await expect(page).toHaveURL(/\/settings\/security\?alert=/);
    const alert = page.getByRole("dialog", { name: "Alert: Rory Reid" });
    await expect(alert.getByText(/Told /)).toBeVisible();
    await expect(alert.getByRole("img", { name: /past the limit at/ })).toBeVisible();
    await settle(page);
    await reviewCopy(page, "owner-alert-light.png");
    expect(await axe(page)).toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    await settle(page);
    await reviewCopy(page, "owner-alert-dark.png");
    expect(await axe(page)).toEqual([]);
    await page.emulateMedia({ colorScheme: "light" });

    // Restore: answered, and Rory is back in.
    await alert.getByRole("button", { name: /Restore access/ }).click();
    await expect(alert.getByText("Rory has access again")).toBeVisible();
    await expect(page.getByRole("region", { name: "All quiet" })).toBeVisible();
    await expect(alert).toBeHidden({ timeout: 5000 });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `overview-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await signIn(rp);
    await expect(rp).not.toHaveURL(/\/sign-in/);
    await expect(alertIn(rp)).toHaveCount(0);
    await rory.close();
  });

  test("Rules and Access limits, both themes", async ({ page }) => {
    for (const [path, name] of [
      ["/settings/security/rules", "rules"],
      ["/settings/security/access", "access"],
    ] as const) {
      await openApp(page, path);
      await expect(page.getByRole("navigation", { name: "Security" })).toBeVisible();
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await settle(page);
        await reviewCopy(page, `${name}-${theme}.png`);
        expect(await axe(page)).toEqual([]);
      }
      await page.emulateMedia({ colorScheme: "light" });
    }
    // A rule opened, for its picture: the stepper and what LUME does.
    await openApp(page, "/settings/security/rules");
    await page
      .getByRole("group", { name: /contacts opened in an hour/ })
      .getByRole("button", { name: "Edit" })
      .click();
    await settle(page);
    await reviewCopy(page, "rules-open-light.png");
    // Access limits: custom hours and a network, unsaved, with the save bar.
    await openApp(page, "/settings/security/access");
    await page.getByRole("radio", { name: /^Custom/ }).check({ force: true });
    await page.getByRole("radio", { name: /Only these networks/ }).check({ force: true });
    await settle(page);
    await reviewCopy(page, "access-editing-light.png");
    expect(await axe(page)).toEqual([]);
  });
});
