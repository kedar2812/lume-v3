import type { Page } from "@playwright/test";
import { expect, stateFile, test, type Who } from "./fixtures";
import { settle } from "./settle";

/** Anything that changes from run to run (clocks, QR codes, secrets) is masked, never allowed to drift. */
const volatile = (page: Page) => [
  page.locator('[class*="clock"]'),
  page.getByRole("img", { name: /QR code/ }),
  page.getByTestId("totp-secret"),
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
