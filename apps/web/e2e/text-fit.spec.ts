import { expect, openApp, stateFile, test } from "./fixtures";
import { SCREENS, cutText } from "./spills";
import { settle } from "./settle";

/**
 * No text cut off, anywhere (owner, 2026-11-02): every screen LUME's layout sweep visits, on a laptop and a phone, in
 * both themes, is checked for text drawn past the edge of a box that hides its overflow. An ellipsis or a line clamp on
 * purpose is fine; a scroller is fine. What opens over a screen is checked in opened.spec; the What's new window at
 * every width in whats-new.spec.
 */
test.use({ storageState: stateFile("owner") });

for (const size of [
  { width: 1366, height: 800 },
  { width: 390, height: 844 },
])
  for (const theme of ["porcelain", "obsidian"] as const)
    test(`no text cut off on any screen at ${size.width}×${size.height} (${theme})`, async ({
      page,
      context,
    }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(size);
      await context.addCookies([{ name: "lume_theme", value: theme, url: "http://127.0.0.1:3100" }]);
      const problems: string[] = [];
      for (const path of SCREENS) {
        await openApp(page, path);
        await page.waitForLoadState("networkidle");
        await settle(page);
        for (const p of await cutText(page)) problems.push(`${path}: ${p}`);
      }
      expect(problems).toEqual([]);
    });
