import type { Browser, Page } from "@playwright/test";
import { callApi, expect, hydrated, lastMailTo, linkIn, openApp, PEOPLE, stateFile, test } from "./fixtures";

/**
 * Settings against the real stack (spec §7 and §2's flows). Every test puts back what it changed, in a
 * `finally` through the API, so the screenshot and role-snapshot specs that run later see the seeded
 * workspace even when a test fails halfway.
 */

type Stage = { id: string; name: string };
type Role = {
  id: string;
  name: string;
  grants: { key: string; scope: string | null }[];
  fieldAccess: { fieldId: string; access: string }[];
};

const withSeller = async (browser: Browser, run: (p: Page) => Promise<void>) => {
  const ctx = await browser.newContext({ storageState: stateFile("seller") });
  const p = await ctx.newPage();
  try {
    await run(p);
  } finally {
    await ctx.close();
  }
};
/** Our own status line; the toast region is a second, usually empty, role="status". */
const note = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
const stages = async (page: Page) =>
  (await callApi<{ pipelines: { stages: Stage[] }[] }>(page, "GET", "/api/v1/pipelines")).data.pipelines[0]!
    .stages;
const roleNamed = async (page: Page, name: string) =>
  (await callApi<{ roles: Role[] }>(page, "GET", "/api/v1/roles")).data.roles.find((r) => r.name === name)!;

test("@smoke rename a stage and see it on the board", async ({ page }) => {
  await openApp(page, "/settings/pipeline");
  const replied = (await stages(page)).find((s) => s.name === "Replied")!;
  try {
    await page.getByRole("button", { name: "Rename Replied" }).click();
    const box = page.getByRole("textbox", { name: "Stage name" });
    await box.fill("Replied by DM");
    await box.press("Enter");
    await expect(note(page, "Renamed to Replied by DM")).toBeVisible();
    await openApp(page, "/pipeline");
    await expect(page.getByText("Replied by DM").first()).toBeVisible();
  } finally {
    await callApi(page, "PATCH", `/api/v1/stages/${replied.id}`, { name: "Replied" });
  }
});

test("@smoke add a field and see it on the New lead form", async ({ page }) => {
  await openApp(page, "/settings/fields");
  try {
    await page.getByRole("button", { name: "Add a field" }).click();
    await page.getByLabel("Field name").fill("Referred by");
    await expect(
      page.getByRole("region", { name: "Lead form preview" }).getByRole("textbox", { name: "Referred by" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create field" }).click();
    await expect(note(page, "Referred by added")).toBeVisible();

    await openApp(page, "/leads");
    await page.getByRole("button", { name: "New lead" }).first().click();
    await expect(
      page.getByRole("dialog", { name: "New lead" }).getByRole("textbox", { name: "Referred by" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // Put away through the screen: archived, never deleted.
    await openApp(page, "/settings/fields");
    await page.getByRole("button", { name: "Edit Referred by" }).click();
    await page.getByRole("button", { name: "Archive Referred by" }).click();
    await page
      .getByRole("dialog", { name: "Archive Referred by?" })
      .getByRole("button", { name: "Archive field" })
      .click();
    await expect(page.getByRole("button", { name: "Edit Referred by" })).toHaveCount(0);
  } finally {
    const { fields } = (
      await callApi<{ fields: { id: string; label: string; archived: boolean }[] }>(
        page,
        "GET",
        "/api/v1/fields",
      )
    ).data;
    for (const f of fields.filter((x) => x.label === "Referred by" && !x.archived))
      await callApi(page, "POST", `/api/v1/fields/${f.id}/archive`);
  }
});

test("@smoke hide a field from Sales and it vanishes for Noor", async ({ page, browser }) => {
  // Noor's Columns picker offers every field she can see.
  const offered = (p: Page, name: string) =>
    p.getByRole("dialog", { name: "Columns" }).getByRole("checkbox", { name });
  await withSeller(browser, async (p) => {
    await openApp(p, "/leads");
    await p.getByRole("button", { name: "Columns" }).click();
    await expect(offered(p, "Struggles")).toBeVisible();
  });

  await openApp(page, "/settings/roles");
  const sales = await roleNamed(page, "Sales");
  try {
    await page.getByRole("button", { name: /^Sales/ }).click();
    await page.getByRole("tab", { name: "Fields" }).click();
    await page.getByRole("radio", { name: "Struggles: Hidden" }).check();
    await expect(page.getByRole("radio", { name: "Struggles: Hidden" })).toBeChecked();

    await withSeller(browser, async (p) => {
      await openApp(p, "/leads");
      await p.getByRole("button", { name: "Columns" }).click();
      await expect(offered(p, "Stage")).toBeVisible();
      await expect(offered(p, "Struggles")).toHaveCount(0);
    });
  } finally {
    await callApi(page, "PUT", `/api/v1/roles/${sales.id}/field-access`, { entries: sales.fieldAccess });
  }
});

test("@smoke invite, then disable someone: their session dies and their leads move", async ({
  page,
  browser,
}) => {
  const person = {
    email: "omar.test@nupuur.test",
    name: "Omar Test",
    password: "sunrise over the creek at five",
  };
  await openApp(page, "/settings/people");
  const since = new Date(Date.now() - 1000).toISOString();
  await page.getByLabel("Email", { exact: true }).fill(person.email);
  await page.getByLabel("Name", { exact: true }).fill(person.name);
  await page.getByLabel("Role", { exact: true }).selectOption({ label: "Sales" });
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(note(page, `Invite sent to ${person.email}`)).toBeVisible();

  // Omar joins from the email and is signed in (at the agreement, the first stop).
  const link = linkIn(await lastMailTo(page.request, person.email, since), "invite");
  const omarCtx = await browser.newContext();
  const omar = await omarCtx.newPage();
  await omar.goto(link);
  await hydrated(omar);
  await omar.getByLabel("Choose a password").fill(person.password);
  await omar.getByRole("button", { name: "Join LUME" }).click();
  await expect(omar).toHaveURL(/\/agree$/);

  // A lead of his own, to hand over.
  const people = (await callApi<{ people: { id: string; name: string }[] }>(page, "GET", "/api/v1/people"))
    .data.people;
  const idOf = (name: string) => people.find((x) => x.name === name)!.id;
  const created = await callApi<{ lead: { id: string } }>(page, "POST", "/api/v1/leads", {
    name: "Handover Lead",
    phone: "+971509990001",
    ownerId: idOf(person.name),
  });
  expect(created.status, JSON.stringify(created.data)).toBe(201);
  const leadId = created.data.lead.id;

  try {
    await openApp(page, "/settings/people");
    await page.getByRole("button", { name: `Disable ${person.name}` }).click();
    const ask = page.getByRole("dialog", { name: `Disable ${person.name}?` });
    await expect(ask).toContainText("Omar will be signed out everywhere");
    await ask.getByLabel("Omar’s leads go to").selectOption({ label: PEOPLE.seller.name });
    await ask.getByRole("button", { name: "Disable" }).click();
    await expect(page.getByRole("button", { name: `Enable ${person.name}` })).toBeVisible();

    await omar.reload();
    await expect(omar).toHaveURL(/\/sign-in/);
    const lead = await callApi<{ lead: { ownerId: string } }>(page, "GET", `/api/v1/leads/${leadId}`);
    expect(lead.data.lead.ownerId).toBe(idOf(PEOPLE.seller.name));
  } finally {
    await omarCtx.close();
    await callApi(page, "DELETE", `/api/v1/leads/${leadId}`);
  }
});

test("@smoke read the audit log", async ({ page }) => {
  await openApp(page, "/settings/audit");
  await expect(page.getByText("The audit log can’t be edited or deleted, by anyone.")).toBeVisible();
  await expect(page.getByText(/ signed in$/).first()).toBeVisible();
  await page.getByLabel("What").selectOption({ label: "Invited someone" });
  await expect(page.getByText(`${PEOPLE.owner.name} invited someone`).first()).toBeVisible();
  await expect(page.getByText(/ signed in$/)).toHaveCount(0);
});

test("switch the currency with a typed rate: every amount converts once", async ({ page }) => {
  const aishaValue = async (text: string) => {
    await openApp(page, "/leads?q=Aisha");
    await expect(page.getByTestId("lead-row").filter({ hasText: "Aisha Khan" })).toContainText(text);
  };
  const switchTo = async (search: string, name: string, code: string, rate: string) => {
    await openApp(page, "/settings/business");
    await page.getByRole("button", { name: "Change currency" }).click();
    await page.getByRole("button", { name: /^New currency/ }).click();
    await page.getByRole("combobox", { name: "Search currencies" }).fill(search);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: `Change the currency to ${name}?` });
    const field = dialog.getByLabel(/^1 [A-Z]{3} in /);
    await expect(field).not.toHaveValue(""); // the quote arrived
    await field.fill(rate);
    await dialog.getByRole("button", { name: `Convert to ${code}` }).click();
    await expect(note(page, `Every amount is now in ${name}.`)).toBeVisible();
  };

  await aishaValue("AED 4,500");
  try {
    await switchTo("usd", "US Dollar", "USD", "0.25");
    await aishaValue("USD 1,125");
  } finally {
    // And back, exactly: whole amounts × 0.25 × 4 come home unchanged.
    await switchTo("AED", "United Arab Emirates Dirham", "AED", "4");
  }
  await aishaValue("AED 4,500");
});

test("a page whose access is removed mid-visit says so", async ({ page, browser }) => {
  // Noor (Sales) is given Business settings, opens them, and loses them before saving.
  await openApp(page, "/settings");
  const sales = await roleNamed(page, "Sales");
  try {
    const give = await callApi(page, "PATCH", `/api/v1/roles/${sales.id}`, {
      grants: [...sales.grants, { key: "settings.manage", scope: null }],
    });
    expect(give.status, JSON.stringify(give.data)).toBe(200);
    await withSeller(browser, async (p) => {
      await openApp(p, "/settings/business");
      const name = p.getByLabel("Business name");
      await expect(name).toBeVisible();
      const take = await callApi(page, "PATCH", `/api/v1/roles/${sales.id}`, { grants: sales.grants });
      expect(take.status, JSON.stringify(take.data)).toBe(200);
      await name.fill("Nupuur Coaching (renamed)");
      await p.getByRole("button", { name: "Save changes" }).click();
      await expect(p.getByRole("heading", { name: "Your access to this page changed" })).toBeVisible();
    });
  } finally {
    await callApi(page, "PATCH", `/api/v1/roles/${sales.id}`, { grants: sales.grants });
  }
});
