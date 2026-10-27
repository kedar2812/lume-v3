import type { Page } from "@playwright/test";
import { expect, openApp, test } from "./fixtures";
import { settle } from "./settle";

/**
 * Nothing spills out of its card (owner, 2026-10-27): Settings → Goals' People table ran out of its card and under the
 * sticky preview on a laptop-sized window. Every screen, at the widths people use, is checked for content wider than
 * the card or panel that holds it, and for a page that scrolls sideways. A table that may be wider than its card
 * belongs in a scroller (overflow-x: auto), which this check accepts.
 */
const SCREENS = [
  "/today",
  "/leads",
  "/leads/not-yet",
  "/pipeline",
  "/calendar",
  "/templates",
  "/media",
  "/replies",
  "/autopilot",
  ...["overview", "funnel", "team", "revenue", "lost", "timing", "quality"].map((m) => `/analytics?m=${m}`),
  "/settings",
  "/settings/business",
  "/settings/pipeline",
  "/settings/calendar/rules",
  "/settings/fields",
  "/settings/lists",
  "/settings/follow-ups",
  "/settings/goals",
  "/settings/sources",
  "/settings/messages",
  "/settings/files",
  "/settings/health",
  "/settings/imports",
  "/settings/integrations",
  "/settings/ai",
  "/settings/people",
  "/settings/roles",
  "/settings/teams",
  "/settings/security",
  "/settings/security/access",
  "/settings/security/rules",
  "/settings/security/exports",
  "/settings/audit",
  "/settings/calendar",
  "/settings/account",
  "/settings/about",
];

/** A laptop, the e2e default, a common desktop, a large one, a tablet held both ways, a phone. */
const WIDTHS = [
  { width: 1280, height: 800 },
  { width: 1366, height: 800 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
];

/** Elements wider than the card that holds them, and whether the page scrolls sideways. */
async function spills(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const transparent = (c: string) => c === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);
    // A card: something drawn as a surface (a fill, a shadow or a border), which content must stay inside.
    const isCard = (cs: CSSStyleDeclaration) =>
      !transparent(cs.backgroundColor) ||
      cs.boxShadow !== "none" ||
      parseFloat(cs.borderLeftWidth) > 0 ||
      parseFloat(cs.borderRightWidth) > 0;
    const clips = (cs: CSSStyleDeclaration) => cs.overflowX !== "visible";
    const name = (el: Element) => {
      const cls = [...el.classList].map((c) => c.replace(/^(.*?)-module__(.*?)___.*$/, "$1.$2")).join(" ");
      const label = el.getAttribute("aria-label") ?? el.getAttribute("name") ?? "";
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${label ? `[${label.slice(0, 40)}]` : ""}`;
    };
    const found = new Map<Element, string>();
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.display === "contents") continue;
      // Out of the flow on purpose: badges, popovers, tooltips, focus decorations.
      if (cs.position === "absolute" || cs.position === "fixed") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      let a = el.parentElement;
      while (a && a !== document.body) {
        const acs = getComputedStyle(a);
        if (clips(acs)) break; // inside a scroller or a clip: handled there
        if (isCard(acs)) {
          const ar = a.getBoundingClientRect();
          const over = Math.max(r.right - ar.right, ar.left - r.left);
          if (over > 1) found.set(el, `${name(el)} spills ${Math.round(over)}px out of ${name(a)}`);
          break;
        }
        a = a.parentElement;
      }
    }
    // Only the outermost spill: its children spill with it.
    const out = [...found]
      .filter(([el]) => !(el.parentElement && found.has(el.parentElement)))
      .map(([, w]) => w);
    // Cards side by side or one under another with no room between them (owner, 2026-10-27: Integrations' cards sat
    // edge to edge). A card here is a rounded surface; rows of a list or a table aren't rounded, so they're left alone.
    const rounded = (el: Element) => {
      // Controls (a toolbar's buttons, a menu's links) sit close on purpose; only surfaces count as cards.
      if (el.matches("button, a, input, select, textarea, label, [role=button], [role=tab], [role=radio]"))
        return false;
      const cs = getComputedStyle(el);
      return (
        isCard(cs) &&
        parseFloat(cs.borderTopLeftRadius) >= 10 &&
        cs.position !== "absolute" &&
        cs.position !== "fixed" &&
        cs.display !== "none" &&
        cs.visibility !== "hidden"
      );
    };
    for (const el of document.querySelectorAll("body *")) {
      const next = el.nextElementSibling;
      if (!next || !rounded(el) || !rounded(next)) continue;
      const a = el.getBoundingClientRect();
      const b = next.getBoundingClientRect();
      if (a.width < 40 || a.height < 24 || b.width < 40 || b.height < 24) continue;
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const gap = overlapX > 8 ? b.top - a.bottom : overlapY > 8 ? b.left - a.right : null;
      if (gap !== null && gap < 4)
        out.push(`${name(el)} and ${name(next)} touch (${Math.round(gap)}px apart)`);
    }
    const sideways = document.documentElement.scrollWidth - window.innerWidth;
    if (sideways > 1) out.unshift(`the page scrolls sideways by ${sideways}px`);
    return [...new Set(out)];
  });
}

for (const size of WIDTHS)
  test(`nothing spills out of its card at ${size.width}×${size.height}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(size);
    const problems: string[] = [];
    for (const path of SCREENS) {
      await openApp(page, path);
      await page.waitForLoadState("networkidle");
      await settle(page);
      for (const p of await spills(page)) problems.push(`${path}: ${p}`);
    }
    expect(problems).toEqual([]);
  });

test("the Settings menu: the item under the pointer never looks like the one you're on (owner, 2026-10-27)", async ({
  page,
}) => {
  // Hovering My account under the current Calendar drew a second raised box 1 px away: two items looked selected.
  await openApp(page, "/settings/calendar");
  const nav = page.getByRole("navigation", { name: "Settings" });
  const here = nav.getByRole("link", { name: "Calendar", exact: true });
  const next = nav.getByRole("link", { name: "My account" });
  await expect(here).toHaveAttribute("aria-current", "page");
  await next.hover();
  await page.waitForTimeout(300); // past the hover's own transition
  const look = (l: typeof here) =>
    l.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, shadow: cs.boxShadow, weight: Number(cs.fontWeight) };
    });
  const [a, b] = [await look(here), await look(next)];
  expect(b.bg).toBe("rgba(0, 0, 0, 0)");
  expect(b.shadow).toBe("none");
  expect(a.weight).toBeGreaterThan(b.weight);
});
