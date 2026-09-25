import type { Page } from "@playwright/test";
import { expect, stateFile, test, type Who } from "./fixtures";
import { settle } from "./settle";

/** Anything that changes from run to run (clocks, QR codes, secrets) is masked, never allowed to drift. */
const volatile = (page: Page) => [
  page.locator('[class*="clock"]'),
  page.getByRole("img", { name: /QR code/ }),
  page.getByTestId("totp-secret"),
  page.locator("[data-volatile]"), // relative times: "3h ago", "In New since today"
];

type Shot = { name: string; path: string; who: Who | null; ready: (p: Page) => Promise<unknown> };
const SHOTS: Shot[] = [
  {
    name: "design",
    path: "/design",
    who: null,
    ready: (p) => p.getByRole("heading", { level: 1 }).waitFor(),
  },
  {
    name: "sign-in",
    path: "/sign-in",
    who: null,
    ready: (p) => p.getByRole("button", { name: "Sign in" }).waitFor(),
  },
  { name: "today", path: "/today", who: "owner", ready: (p) => p.getByTestId("lockup").waitFor() },
  {
    name: "today-tour",
    path: "/today?tour=1",
    who: "owner",
    ready: (p) => p.getByRole("dialog", { name: /tour/i }).waitFor(),
  },
  {
    name: "welcome",
    path: "/welcome",
    who: "admin",
    ready: (p) => p.getByRole("dialog", { name: /welcome to lume/i }).waitFor(),
  },
  {
    name: "leads",
    path: "/leads?q=Karim",
    who: "owner",
    ready: (p) => p.getByRole("button", { name: "Open Karim Aziz" }).waitFor(),
  },
  {
    name: "lead-drawer",
    path: "/leads?q=Karim",
    who: "owner",
    ready: async (p) => {
      await p.getByRole("button", { name: "Open Karim Aziz" }).click();
      await p
        .getByRole("dialog", { name: "Karim Aziz" })
        .getByRole("heading", { name: "Karim Aziz" })
        .waitFor();
    },
  },
  {
    name: "pipeline",
    path: "/pipeline",
    who: "owner",
    ready: (p) => p.getByRole("region").first().waitFor(),
  },
];

for (const theme of ["porcelain", "obsidian"] as const) {
  for (const s of SHOTS) {
    test.describe(`${s.name} (${theme})`, () => {
      test.use({ storageState: s.who ? stateFile(s.who) : { cookies: [], origins: [] } });
      test("looks as approved", async ({ page, context }) => {
        await context.addCookies([{ name: "lume_theme", value: theme, url: "http://127.0.0.1:3100" }]);
        await page.goto(s.path);
        await s.ready(page);
        await settle(page);
        await expect(page).toHaveScreenshot(`${s.name}-${theme}.png`, {
          fullPage: true,
          mask: volatile(page),
        });
      });
    });
  }
}

/** What each role can reach is part of the design: the sidebar, as the accessibility tree reads it. */
for (const who of ["owner", "rep"] as const) {
  test.describe(`navigation for the ${who}`, () => {
    test.use({ storageState: stateFile(who) });
    test("matches the approved role snapshot", async ({ page }) => {
      await page.goto("/today");
      await expect(page.getByRole("navigation", { name: "Main" })).toMatchAriaSnapshot({
        name: `nav-${who}.aria.yml`,
      });
    });
  });
}

/**
 * What a role can do on the leads screens is part of the design too (spec §8): the toolbar and table
 * header, and a drawer, as the accessibility tree reads them, so no control can leak into a rep's screen.
 */
for (const [who, lead] of [
  ["owner", "Karim Aziz"],
  ["seller", "Aisha Khan"],
] as const) {
  test.describe(`leads for the ${who}`, () => {
    test.use({ storageState: stateFile(who) });
    test("match the approved role snapshots", async ({ page }) => {
      await page.goto(`/leads?q=${encodeURIComponent(lead.split(" ")[0]!)}`);
      await expect(page.getByTestId("leads-toolbar")).toMatchAriaSnapshot({
        name: `leads-toolbar-${who}.aria.yml`,
      });
      await expect(page.getByRole("row").first()).toMatchAriaSnapshot({
        name: `leads-header-${who}.aria.yml`,
      });
      await page.getByRole("button", { name: `Open ${lead}` }).click();
      const drawer = page.getByRole("dialog", { name: lead });
      await drawer.getByRole("heading", { name: lead }).waitFor();
      await expect(drawer).toMatchAriaSnapshot({ name: `lead-drawer-${who}.aria.yml` });
    });
  });
}
