import { readFile } from "node:fs/promises";
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
    // Seven leads of his own: reveals count different leads' contacts.
    const names = [
      "Dana Whitfield",
      "Lina Rahim",
      "Omar Saleh",
      "Priya Nair",
      "Karim Haddad",
      "Sara Lowe",
      "Noor Faris",
    ];
    for (const [i, name] of names.entries()) {
      const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", {
        name,
        phone: `+97150111${2230 + i}`,
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
    for (const id of leads.slice(2, 5))
      expect((await callApi(rp, "POST", `/api/v1/leads/${id}/contact/reveal`)).status).toBe(200);
    await openApp(rp, `/leads?lead=${leads[0]}`);
    const drawer = rp.getByRole("dialog", { name: "Dana Whitfield" });
    await drawer.getByRole("button", { name: "Reveal contact" }).click();
    await expect(drawer.getByRole("note")).toContainText("You’ve opened a lot of contacts this hour");
    await expect(drawer.getByRole("note")).not.toContainText(/\d/);
    await settle(rp);
    await reviewCopy(rp, "rep-near-limit-light.png");
    expect(await axe(rp)).toEqual([]);

    // The fifth is shown; the sixth crosses the line: refused, and from then on Rory is paused.
    expect((await callApi(rp, "POST", `/api/v1/leads/${leads[5]}/contact/reveal`)).status).toBe(200);
    const sixth = await callApi<{ error: { code: string } }>(
      rp,
      "POST",
      `/api/v1/leads/${leads[6]}/contact/reveal`,
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
    await expect(alert).toBeHidden({ timeout: 5000 });
    // Rory's alert is answered: out of the open list, into Earlier with who restored him. (Other specs' people
    // may have alerts of their own — a run of send queues — so the status card isn't asserted here.)
    await expect(page.getByRole("list", { name: "Open alerts" }).getByText(/^Rory Reid opened/)).toHaveCount(
      0,
    );
    await expect(page.getByRole("list", { name: "Earlier alerts" })).toContainText("Restored by Maya Kapoor");
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

  test("6B: export the view, then trace the file — with its column, and without", async ({ page }) => {
    await openApp(page, "/leads");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: /^Export / });
    await expect(sheet).toContainText("Each file carries a mark that traces it back to you.");
    await settle(page);
    await reviewCopy(sheet, "export-sheet-light.png");
    expect(await axe(page)).toEqual([]);
    const downloading = page.waitForEvent("download");
    await sheet.getByRole("button", { name: "Export", exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^LUME leads .+ [A-Z2-9]{4}-[A-Z2-9]{4}\.csv$/);
    const code = /([A-Z2-9]{4}-[A-Z2-9]{4})\.csv$/.exec(download.suggestedFilename())![1]!;
    const text = (await readFile((await download.path())!, "utf8")).replace(/^\uFEFF/, "");
    expect(text.split(/\r?\n/)[0]).toMatch(/,LUME ref$/);
    await expect(sheet).toContainText(`code ${code}`);
    await sheet.getByRole("button", { name: "Done" }).click();

    // Trace it: as made, then with the LUME ref column cut out.
    await openApp(page, "/settings/security/exports");
    const choose = page.getByLabel("Choose a file");
    await choose.setInputFiles({ name: "found.csv", mimeType: "text/csv", buffer: Buffer.from(text) });
    const found = page.getByRole("region", { name: "Maya Kapoor’s export" });
    await expect(found).toContainText(`code ${code}`);
    await expect(found).toContainText("The LUME ref column");
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `exports-found-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: "Check another file" }).click();
    const cut = text
      .split(/\r?\n/)
      .map((l) => l.replace(/,(LUME ref|[A-Z2-9]{4}-[A-Z2-9]{4})$/, ""))
      .join("\n");
    await page
      .getByLabel("Choose a file")
      .setInputFiles({ name: "cut.csv", mimeType: "text/csv", buffer: Buffer.from(cut) });
    await expect(page.getByRole("region", { name: "Maya Kapoor’s export" })).toContainText(
      "A hidden check row.",
    );
    await reviewCopy(page, "exports-check-row-light.png");
    await page.getByRole("button", { name: "Check another file" }).click();
    await page.getByLabel("Choose a file").setInputFiles({
      name: "other.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Name,Phone\nSomeone Else,+971500000000\n"),
    });
    await expect(page.getByText("No LUME export matches this file")).toBeVisible();
    await reviewCopy(page, "exports-none-light.png");
    // The list: this export, its code, and Download for its maker.
    await openApp(page, "/settings/security/exports");
    await expect(page.getByRole("list", { name: "Exports" })).toContainText(code);
    await page.emulateMedia({ colorScheme: "dark" });
    await settle(page);
    await reviewCopy(page, "exports-list-dark.png");
    await page.emulateMedia({ colorScheme: "light" });
  });
});

/**
 * Offboarding (6C) on the real stack: Rory (made and restored by the watch's test above) is offboarded from People,
 * his leads shared across a team by who has the fewest open leads. The team and his leads are this spec's own.
 */
test.describe("Offboarding (6C)", () => {
  const made: { team?: string; leads: string[] } = { leads: [] };

  test.afterAll(async ({ browser }) => {
    const { ctx, page } = await asOwner(browser);
    await openApp(page, "/today");
    if (made.leads.length)
      await callApi(page, "POST", "/api/v1/leads/bulk", { ids: made.leads, action: { type: "delete" } });
    if (made.team) await callApi(page, "DELETE", `/api/v1/teams/${made.team}`);
    await ctx.close();
  });

  test("offboard Rory from People: his leads shared across the team, every step ticked", async ({ page }) => {
    await openApp(page, "/today");
    const people = (await callApi<{ people: { id: string; name: string }[] }>(page, "GET", "/api/v1/people"))
      .data.people;
    const rory = people.find((p) => p.name === RORY.name)!;
    const aman = people.find((p) => p.name === "Aman Verma")!;
    for (const [i, name] of ["Hadi Karam", "Mira Sayed", "Tom Ellis"].entries()) {
      const r = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", {
        name,
        phone: `+97150222${3340 + i}`,
        ownerId: rory.id,
      });
      made.leads.push(r.data.lead.id);
    }
    const team = await callApi<{ team: { id: string } }>(page, "POST", "/api/v1/teams", {
      name: "Field sales",
    });
    made.team = team.data.team.id;
    await callApi(page, "PUT", `/api/v1/teams/${made.team}/members`, {
      members: [
        { userId: aman.id, isLead: true },
        { userId: rory.id, isLead: false },
      ],
    });

    await openApp(page, "/settings/people");
    await page.getByRole("button", { name: `Offboard ${RORY.name}` }).click();
    const sheet = page.getByRole("dialog", { name: `Offboard ${RORY.name}` });
    await expect(sheet.getByText("Hand on Rory’s 3 leads")).toBeVisible();
    await expect(sheet.getByRole("radio", { name: /Share them across the Field sales team/ })).toBeChecked();
    await expect(sheet.getByText("Aman Verma · 3")).toBeVisible();
    await expect(sheet.getByRole("list", { name: "Rory’s last 30 days" })).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await reviewCopy(page, `offboard-sheet-${theme}.png`);
      expect(await axe(page)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });

    await sheet.getByRole("button", { name: "Offboard Rory" }).click();
    await expect(sheet.getByText("Done · 3 leads shared: Aman 3")).toBeVisible();
    await expect(sheet.getByRole("status")).toHaveText("Rory Reid is offboarded. LUME recorded every step.");
    await settle(page);
    await reviewCopy(page, "offboard-done-light.png");
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: `Enable ${RORY.name}` })).toBeVisible();

    // Rory's leads are Aman's now.
    const lead = await callApi<{ lead: { ownerId: string } }>(page, "GET", `/api/v1/leads/${made.leads[0]}`);
    expect(lead.data.lead.ownerId).toBe(aman.id);
  });
});
