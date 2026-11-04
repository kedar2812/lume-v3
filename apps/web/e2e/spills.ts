import type { Page } from "@playwright/test";

/** The screens and widths LUME's layout sweeps visit, and the checks they share (layout, text fit, What's new). */
export const SCREENS = [
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
export const WIDTHS = [
  { width: 1280, height: 800 },
  { width: 1366, height: 800 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
];

/** Elements wider than the card that holds them, and whether the page scrolls sideways. */
export async function spills(page: Page): Promise<string[]> {
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

/**
 * Text cut off by its box (owner, 2026-11-02: the mock's headline mask cut the foot of "your"). Each piece of text is
 * measured as drawn (its glyph boxes, ascenders and descenders included) against the nearest box that hides its
 * overflow; a scroller or a deliberate ellipsis or line clamp is fine, and so is text that isn't showing.
 */
export async function cutText(page: Page, root = "body"): Promise<string[]> {
  return page.evaluate((rootSel) => {
    const name = (el: Element) => {
      const cls = [...el.classList].map((c) => c.replace(/^(.*?)-module__(.*?)___.*$/, "$1.$2")).join(" ");
      const label = el.getAttribute("aria-label") ?? "";
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${label ? `[${label.slice(0, 40)}]` : ""}`;
    };
    const out = new Map<Element, string>();
    const rootEl = document.querySelector(rootSel);
    if (!rootEl) return [];
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim();
      const parent = n.parentElement;
      if (!text || !parent) continue;
      if (!parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      // Put away on purpose: a collapsed section (Access's networks while "Anywhere") is inert while it's closed.
      if (parent.closest("[inert]")) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!rects.length) continue;
      const box = {
        top: Math.min(...rects.map((r) => r.top)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
        left: Math.min(...rects.map((r) => r.left)),
        right: Math.max(...rects.map((r) => r.right)),
      };
      for (let a: Element | null = parent; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.textOverflow === "ellipsis" || (cs.webkitLineClamp && cs.webkitLineClamp !== "none")) break;
        const scrolls = (v: string) => v === "auto" || v === "scroll";
        if (scrolls(cs.overflowX) || scrolls(cs.overflowY)) break;
        const hides = (v: string) => v === "hidden" || v === "clip";
        if (!hides(cs.overflowX) && !hides(cs.overflowY)) continue;
        const r = a.getBoundingClientRect();
        // A screen-reader-only box clips on purpose.
        if (r.width <= 2 || r.height <= 2) break;
        // The padding box: inside the borders.
        const top = r.top + parseFloat(cs.borderTopWidth);
        const bottom = r.bottom - parseFloat(cs.borderBottomWidth);
        const left = r.left + parseFloat(cs.borderLeftWidth);
        const right = r.right - parseFloat(cs.borderRightWidth);
        const cut: string[] = [];
        if (hides(cs.overflowY) && box.top < top - 1) cut.push(`${Math.round(top - box.top)}px at the top`);
        if (hides(cs.overflowY) && box.bottom > bottom + 1)
          cut.push(`${Math.round(box.bottom - bottom)}px at the foot`);
        if (hides(cs.overflowX) && box.left < left - 1)
          cut.push(`${Math.round(left - box.left)}px on the left`);
        if (hides(cs.overflowX) && box.right > right + 1)
          cut.push(`${Math.round(box.right - right)}px on the right`);
        if (cut.length && !out.has(a))
          out.set(a, `"${text.slice(0, 30)}" is cut ${cut.join(", ")} by ${name(a)}`);
        break;
      }
    }
    return [...out.values()];
  }, root);
}
