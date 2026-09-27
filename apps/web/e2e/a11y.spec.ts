import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, stateFile, test, type Who } from "./fixtures";
import { chooseFile, next, openImportSheet } from "./imports-helpers";
import { settle } from "./settle";

async function axe(page: Page) {
  await settle(page); // measure the settled page, not a frame mid-entrance
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  return results.violations.map(
    (v) =>
      `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} (${n.any[0]?.message ?? n.failureSummary})`).join(" | ")}`,
  );
}

// A one-row file whose stage LUME doesn't know: every step has something to show, and no lead is ever made.
const A11Y_CSV = ["Name,Stage", "Axe Check,Nowhere", ""].join("\n");
const importAt = async (p: Page, steps: number) => {
  const sheet = await openImportSheet(p);
  await chooseFile(sheet, "a11y-check.csv", A11Y_CSV);
  for (let i = 0; i < steps; i++) await next(sheet);
  return sheet;
};

type Check = { name: string; path: string; who: Who | null; ready: (p: Page) => Promise<unknown> };
const CHECKS: Check[] = [
  {
    name: "sign-in",
    path: "/sign-in",
    who: null,
    ready: (p) => p.getByRole("button", { name: "Sign in" }).waitFor(),
  },
  {
    name: "forgot",
    path: "/forgot",
    who: null,
    ready: (p) => p.getByRole("button", { name: /send/i }).waitFor(),
  },
  {
    name: "dead invite",
    path: `/invite/${"z".repeat(43)}`,
    who: null,
    ready: (p) => p.getByText(/no longer valid/i).waitFor(),
  },
  {
    name: "design",
    path: "/design",
    who: null,
    ready: (p) => p.getByRole("heading", { level: 1 }).waitFor(),
  },
  {
    name: "agreement",
    path: "/agree",
    who: "fresh",
    ready: (p) => p.getByRole("button", { name: "I agree" }).waitFor(),
  },
  {
    name: "welcome (admin)",
    path: "/welcome",
    who: "admin",
    ready: (p) => p.getByRole("dialog", { name: /welcome to lume/i }).waitFor(),
  },
  { name: "today", path: "/today", who: "owner", ready: (p) => p.getByTestId("lockup").waitFor() },
  {
    name: "today with the tour open",
    path: "/today?tour=1",
    who: "owner",
    ready: (p) => p.getByRole("dialog", { name: /tour/i }).waitFor(),
  },
  {
    name: "settings",
    path: "/settings",
    who: "owner",
    ready: (p) => p.locator("#settings-title", { hasText: "Settings" }).waitFor(),
  },
  {
    name: "settings: business",
    path: "/settings/business",
    who: "owner",
    ready: (p) => p.locator("#settings-title", { hasText: "Business" }).waitFor(),
  },
  {
    name: "settings: pipeline",
    path: "/settings/pipeline",
    who: "owner",
    ready: (p) => p.locator("#settings-title", { hasText: "Pipeline & stages" }).waitFor(),
  },
  {
    name: "settings: fields",
    path: "/settings/fields",
    who: "owner",
    ready: (p) => p.locator("#settings-title", { hasText: "Fields" }).waitFor(),
  },
  {
    name: "settings: lists",
    path: "/settings/lists",
    who: "owner",
    ready: (p) => p.locator("#settings-title", { hasText: "Lists" }).waitFor(),
  },
  {
    name: "settings: people",
    path: "/settings/people",
    who: "owner",
    ready: (p) => p.locator("#settings-title", { hasText: "People" }).waitFor(),
  },
  {
    name: "settings: teams",
    path: "/settings/teams",
    who: "owner",
    ready: (p) => p.locator("#settings-title", { hasText: "Teams" }).waitFor(),
  },
  {
    name: "settings: roles",
    path: "/settings/roles",
    who: "owner",
    ready: (p) => p.locator("#settings-title", { hasText: "Roles & access" }).waitFor(),
  },
  {
    name: "settings: account",
    path: "/settings/account",
    who: "owner",
    ready: (p) => p.locator("#settings-title", { hasText: "My account" }).waitFor(),
  },
  {
    name: "settings: audit",
    path: "/settings/audit",
    who: "owner",
    ready: (p) => p.locator("#settings-title", { hasText: "Audit log" }).waitFor(),
  },
  {
    name: "settings: about",
    path: "/settings/about",
    who: "owner",
    ready: (p) => p.locator("#settings-title", { hasText: "About" }).waitFor(),
  },
  {
    name: "settings: currency dialog",
    path: "/settings/business",
    who: "owner",
    ready: async (p) => {
      await p.getByRole("button", { name: "Change currency" }).click();
      await p.getByRole("button", { name: /^New currency/ }).click();
      await p.getByRole("combobox", { name: "Search currencies" }).fill("usd");
      await p.keyboard.press("Enter");
      await p
        .getByRole("dialog", { name: "Change the currency to US Dollar?" })
        .getByText(/^1 AED = /)
        .waitFor();
    },
  },
  {
    name: "settings (sales)",
    path: "/settings",
    who: "seller",
    ready: (p) => p.locator("#settings-title", { hasText: "Settings" }).waitFor(),
  },
  { name: "leads", path: "/leads", who: "owner", ready: (p) => p.getByTestId("lead-row").first().waitFor() },
  {
    name: "leads (sales)",
    path: "/leads",
    who: "seller",
    ready: (p) => p.getByTestId("lead-row").first().waitFor(),
  },
  {
    name: "lead drawer",
    path: "/leads?q=Karim",
    who: "owner",
    ready: async (p) => {
      await p.getByRole("button", { name: "Open Karim Aziz" }).click();
      await p.getByRole("dialog", { name: "Karim Aziz" }).waitFor();
    },
  },
  {
    name: "new lead sheet",
    path: "/leads",
    who: "owner",
    ready: async (p) => {
      await p.getByRole("button", { name: "New lead" }).first().click();
      await p
        .getByRole("dialog", { name: "New lead" })
        .getByRole("button", { name: /^Country code/ })
        .click();
      await p.getByRole("listbox", { name: "Countries" }).waitFor(); // checked with the country list open
    },
  },
  {
    name: "import: the file as read",
    path: "/leads",
    who: "owner",
    ready: (p) => importAt(p, 0),
  },
  {
    name: "import: columns, with a value LUME doesn't recognise",
    path: "/leads",
    who: "owner",
    ready: async (p) =>
      (await importAt(p, 1)).getByRole("region", { name: "Values LUME doesn't recognise" }).waitFor(),
  },
  {
    name: "import: rules",
    path: "/leads",
    who: "owner",
    ready: async (p) => (await importAt(p, 2)).getByRole("heading", { name: "How to add them" }).waitFor(),
  },
  {
    name: "import: preview",
    path: "/leads",
    who: "owner",
    ready: async (p) => (await importAt(p, 3)).getByText("1 error").waitFor(),
  },
  {
    name: "import: the report",
    path: "/leads",
    who: "owner",
    ready: async (p) => {
      const sheet = await importAt(p, 3);
      await sheet.getByRole("button", { name: "Import 1 row" }).click();
      await sheet.getByRole("heading", { name: /^a11y-check\.csv was checked/ }).waitFor();
    },
  },
  {
    name: "settings: imports",
    path: "/settings/imports",
    who: "owner",
    ready: (p) => p.getByRole("region", { name: "Past imports" }).waitFor(),
  },
  {
    name: "pipeline board",
    path: "/pipeline",
    who: "owner",
    ready: (p) => p.getByRole("region").first().waitFor(),
  },
];

for (const theme of ["porcelain", "obsidian"] as const) {
  for (const c of CHECKS) {
    test.describe(`${c.name} (${theme})`, () => {
      test.use({ storageState: c.who ? stateFile(c.who) : { cookies: [], origins: [] } });
      test(`has no axe violations`, async ({ page, context }) => {
        await context.addCookies([{ name: "lume_theme", value: theme, url: "http://127.0.0.1:3100" }]);
        await page.goto(c.path);
        await c.ready(page);
        expect(await axe(page)).toEqual([]);
      });
    });
  }
}
