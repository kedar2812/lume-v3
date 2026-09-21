import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settle } from "./settle";

for (const theme of ["porcelain", "obsidian"] as const) {
  for (const path of ["/sign-in", "/today", "/design"]) {
    test(`${path} has no axe violations (${theme})`, async ({ page, context }) => {
      await context.addCookies([{ name: "lume_theme", value: theme, url: "http://127.0.0.1:3100" }]);
      await page.goto(path);
      await settle(page); // measure the settled page, not a frame mid-entrance
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      const detail = results.violations.map(
        (v) =>
          `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} (${n.any[0]?.message ?? n.failureSummary})`).join(" | ")}`,
      );
      expect(detail).toEqual([]);
    });
  }
}
