import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, stateFile, test, type Who } from "./fixtures";
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
    ready: (p) => p.getByRole("button", { name: /replay/i }).waitFor(),
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
