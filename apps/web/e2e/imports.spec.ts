import { readFileSync } from "node:fs";
import path from "node:path";
import { callApi, expect, openApp, PEOPLE, stateFile, test } from "./fixtures";
import {
  chooseFile,
  deleteLeadsFrom,
  importNamed,
  importViaApi,
  next,
  openImportSheet,
} from "./imports-helpers";

/**
 * Importing a CSV against the real stack (spec §9, §11): the sheet, the run through the real queue, and
 * the report. Every test deletes the leads it created in a `finally`, so the specs after it (and the
 * screenshots) see the seeded workspace. Fixtures are fictional (Brightpath Studio).
 */
const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");
const lead = async (page: Parameters<typeof callApi>[0], name: string) =>
  (
    await callApi<{ items: { id: string; name: string }[] }>(
      page,
      "GET",
      `/api/v1/leads?q=${encodeURIComponent(name)}`,
    )
  ).data.items.find((l) => l.name === name);

test("@smoke import a CSV end to end", async ({ page }) => {
  test.setTimeout(90_000);
  const sheet = await openImportSheet(page);
  try {
    // File: the title line above the header is stepped over.
    await chooseFile(sheet, "brightpath-leads.csv", fixture("brightpath-leads.csv"));
    await expect(sheet.getByText("brightpath-leads.csv · 12 rows")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Header: row 2" })).toBeVisible();
    await next(sheet);

    // Columns: every suggestion is right, and the one stage LUME doesn't know is asked about.
    const goesTo = (h: string) => sheet.getByRole("combobox", { name: `${h} goes to` });
    await expect(goesTo("Full name")).toHaveValue("name");
    await expect(goesTo("Mobile")).toHaveValue("phone");
    await expect(goesTo("Email")).toHaveValue("email");
    await expect(goesTo("Date")).toHaveValue("lead_created_at");
    await expect(goesTo("Stage")).toHaveValue("stage");
    await expect(goesTo("Tier")).toHaveValue("ignore");
    const unmatched = sheet.getByRole("region", { name: "Values LUME doesn't recognise" });
    await expect(unmatched.getByText("Hot lead")).toBeVisible();
    await unmatched.getByRole("combobox", { name: "Hot lead becomes" }).selectOption({ label: "Replied" });
    await expect(sheet.getByRole("button", { name: "Continue" })).toBeEnabled();
    await next(sheet);

    // Rules: LUME's defaults.
    await expect(sheet.getByRole("radio", { name: /Merge/ })).toBeChecked();
    await next(sheet);

    // Preview: exactly what will happen, before anything is written.
    await expect(sheet.getByText("8 create · 3 merge · 1 empty")).toBeVisible();
    await expect(sheet.getByText(`Merges into Omar Haddad (${PEOPLE.seller.name})`)).toBeVisible();
    await expect(sheet.getByText("Merges into row 3")).toBeVisible();
    await sheet.getByRole("button", { name: "Import 12 rows" }).click();

    // The run, then the report.
    await expect(sheet.getByRole("heading", { name: "brightpath-leads.csv is in LUME" })).toBeVisible({
      timeout: 45_000,
    });
    await expect(sheet.getByText("8 created")).toBeVisible();
    await expect(sheet.getByText("3 merged into existing leads")).toBeVisible();
    await expect(sheet.getByText("1 empty row")).toBeVisible();
    await sheet.getByRole("link", { name: "View imported leads" }).click();
    await expect(
      page.getByRole("button", { name: "Remove filter: From brightpath-leads.csv" }),
    ).toBeVisible();
    await expect(page.getByTestId("lead-row")).toHaveCount(8);

    // The seeded lead that enquired again says so in its history.
    const omar = await lead(page, "Omar Haddad");
    const history = (
      await callApi<{ items: { type: string }[] }>(page, "GET", `/api/v1/leads/${omar!.id}/activities`)
    ).data.items;
    expect(history.map((a) => a.type)).toContain("imported_again");
  } finally {
    const imp = await importNamed(page, "brightpath-leads.csv").catch(() => null);
    if (imp) await deleteLeadsFrom(page, imp.sourceId);
  }
});

test("the European file reads right: semicolons, dd.mm.yyyy and comma decimals", async ({ page }) => {
  test.setTimeout(60_000);
  const sheet = await openImportSheet(page);
  try {
    await chooseFile(sheet, "brightpath-leads-semicolon.csv", fixture("brightpath-leads-semicolon.csv"));
    await expect(sheet.getByRole("button", { name: "Separator: Semicolon" })).toBeVisible();
    await next(sheet);
    await expect(sheet.getByRole("combobox", { name: "Value goes to" })).toHaveValue("value");
    await next(sheet);
    await next(sheet);
    await expect(sheet.getByText("2 create")).toBeVisible();
    await sheet.getByRole("button", { name: "Import 2 rows" }).click();
    await expect(
      sheet.getByRole("heading", { name: "brightpath-leads-semicolon.csv is in LUME" }),
    ).toBeVisible({
      timeout: 45_000,
    });
    const clara = await lead(page, "Clara Jensen");
    const view = (
      await callApi<{ lead: { value: number; leadCreatedAt: string } }>(
        page,
        "GET",
        `/api/v1/leads/${clara!.id}`,
      )
    ).data.lead;
    expect(view).toMatchObject({ value: 1234.5, leadCreatedAt: "2025-03-14" });
  } finally {
    const imp = await importNamed(page, "brightpath-leads-semicolon.csv").catch(() => null);
    if (imp) await deleteLeadsFrom(page, imp.sourceId);
  }
});

test.describe("a rep without Import leads", () => {
  test.use({ storageState: stateFile("seller") });
  test("@smoke sees no Import button", async ({ page }) => {
    await openApp(page, "/leads");
    await page.getByTestId("lead-row").first().waitFor();
    await expect(page.getByRole("button", { name: /^Import/ })).toHaveCount(0);
  });
});

test("cancel, then import the rest", async ({ page }) => {
  test.setTimeout(120_000);
  const rows = Array.from(
    { length: 600 },
    (_, i) => `Batch Lead ${String(i).padStart(3, "0")},05072${String(10000 + i)}`,
  );
  const sheet = await openImportSheet(page);
  try {
    await chooseFile(sheet, "brightpath-batch.csv", `Name,Phone\n${rows.join("\n")}\n`);
    await next(sheet);
    await next(sheet);
    await next(sheet);
    await sheet.getByRole("button", { name: "Import 600 rows" }).click();
    await sheet.getByRole("button", { name: "Cancel import" }).click();
    await expect(sheet.getByText(/Cancelled after row/)).toBeVisible({ timeout: 45_000 });
    await sheet.getByRole("button", { name: "Import the rest" }).click();
    await expect(sheet.getByRole("heading", { name: "brightpath-batch.csv is in LUME" })).toBeVisible({
      timeout: 60_000,
    });
    const imp = await importNamed(page, "brightpath-batch.csv");
    const counts = (await callApi<{ counts: { created: number } }>(page, "GET", `/api/v1/imports/${imp.id}`))
      .data.counts;
    expect(counts.created).toBe(600); // every row once: nothing lost at the cancel, nothing doubled after
  } finally {
    const imp = await importNamed(page, "brightpath-batch.csv").catch(() => null);
    if (imp) await deleteLeadsFrom(page, imp.sourceId);
  }
});

test("@smoke the bulk phone fix gives numbers their country", async ({ page }) => {
  test.setTimeout(60_000);
  // Numbers without a country, as an import with no default country leaves them.
  await openApp(page, "/leads");
  const imp = await importViaApi(
    page,
    "brightpath-needs-code.csv",
    "Name,Phone\nFix Me One,0507300001\nFix Me Two,0507300002\n",
    {
      defaultCountry: null,
    },
  );
  try {
    await openApp(page, "/leads?phone=needs_country");
    await expect(page.getByTestId("lead-row")).toHaveCount(2);
    await page.getByRole("checkbox", { name: "Select all loaded" }).check();
    await page.getByRole("button", { name: "More bulk actions" }).click();
    await page.getByRole("button", { name: "Read phone numbers with a country…" }).click();
    await expect(page.getByRole("button", { name: "Country: United Arab Emirates" })).toBeVisible();
    await page.getByRole("button", { name: "Read 2 with this country" }).click();
    await expect(page.getByText("2 numbers read with a country")).toBeVisible();
    const one = await lead(page, "Fix Me One");
    const view = (
      await callApi<{ lead: { phone: { status: string } } }>(page, "GET", `/api/v1/leads/${one!.id}`)
    ).data.lead;
    expect(view.phone.status).toBe("valid");
  } finally {
    await deleteLeadsFrom(page, imp.sourceId);
  }
});
