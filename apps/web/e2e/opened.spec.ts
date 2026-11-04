import type { Page } from "@playwright/test";
import { callApi, expect, openApp, stateFile, test } from "./fixtures";
import { SCREENS, cutText } from "./spills";
import { settle } from "./settle";

/**
 * Nothing that opens is cut off (owner, 2026-11-04: the template sheet opened inside the chat window and its first card
 * was cut away: "the content is not even visible"). The sweeps elsewhere see each screen as it loads; here every menu,
 * sheet and popover on every screen (and in a lead's drawer) is opened in turn, at a laptop and a phone, and checked:
 * its text isn't cut, no box around it clips it, and it stays on the window.
 */
test.use({ storageState: stateFile("owner") });

/** What hides part of the open panel: an ancestor that clips it, or the window's edge. */
async function panelCut(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = '[data-portal], [role="menu"], [role="listbox"], [role="dialog"]';
    // Only what this click opened: anything already there (the bulk bar waiting off-screen) was marked before it.
    const panels = [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => {
      if (el.hasAttribute("data-sweep-before") || el.closest('[inert], [aria-hidden="true"]')) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden" && el.getClientRects().length > 0;
    });
    for (const el of panels) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const label = el.getAttribute("aria-label") ?? el.getAttribute("role") ?? el.tagName.toLowerCase();
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        const hides = [cs.overflowX, cs.overflowY].some((o) => o === "hidden" || o === "clip");
        if (!hides) continue;
        const ar = a.getBoundingClientRect();
        const over = Math.max(ar.top - r.top, r.bottom - ar.bottom, ar.left - r.left, r.right - ar.right);
        if (over > 1)
          out.push(`${label} is cut ${Math.round(over)}px by ${a.className || a.tagName.toLowerCase()}`);
        break;
      }
      if (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1)
        out.push(
          `${label} runs off the window (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)})`,
        );
    }
    return out;
  });
}

/** Every trigger on the page that opens something, as stable handles (index among visible ones). */
const triggers = (page: Page) =>
  page.locator('button[aria-haspopup]:not([disabled]):visible, [role="button"][aria-haspopup]:visible');

async function sweep(page: Page, where: string, problems: string[]) {
  const n = await triggers(page).count();
  for (let i = 0; i < n; i++) {
    const t = triggers(page).nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    const name = ((await t.getAttribute("aria-label")) ?? (await t.innerText().catch(() => "")))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    await page.evaluate((sel) => {
      document
        .querySelectorAll("[data-sweep-before]")
        .forEach((el) => el.removeAttribute("data-sweep-before"));
      document.querySelectorAll(sel).forEach((el) => el.setAttribute("data-sweep-before", ""));
    }, '[data-portal], [role="menu"], [role="listbox"], [role="dialog"]');
    await t.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(350);
    for (const p of await panelCut(page)) problems.push(`${where} › ${name}: ${p}`);
    for (const p of await cutText(page, "body")) problems.push(`${where} › ${name}: ${p}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    // A sheet that took over the page (a full dialog) is closed again before the next trigger.
    if (await page.locator('[aria-modal="true"]').count()) await page.keyboard.press("Escape");
  }
}

for (const size of [
  { width: 1366, height: 800 },
  { width: 390, height: 844 },
])
  test(`nothing that opens is cut off at ${size.width}×${size.height}`, async ({ page }) => {
    test.setTimeout(900_000);
    await page.setViewportSize(size);
    const problems: string[] = [];
    await openApp(page, "/leads");
    const leads = await callApi<{ items: { id: string }[] }>(page, "GET", "/api/v1/leads?limit=1");
    const lead = leads.data.items?.[0]?.id;
    for (const path of [...SCREENS, ...(lead ? [`/leads?lead=${lead}`] : [])]) {
      await openApp(page, path);
      await page.waitForLoadState("networkidle");
      await settle(page);
      await sweep(page, path, problems);
    }
    expect([...new Set(problems)]).toEqual([]);
  });
