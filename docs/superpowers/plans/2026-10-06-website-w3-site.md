# Website W3 — lumecrm.in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The product website at lumecrm.in that turns Indian sales-led businesses into enquiries — cinematic, light and dark, flawless from a 320 px phone to a 4K screen.

**Architecture:** A Next.js App Router site in its own repo (`kedar2812/lume-landing-page-`), statically rendered, with one route handler for enquiries. A theme system mirrors LUME's (Auto · Light · Dark) and swaps every real capture. The hero ("Lights on") and the navigation ("the Island") are the signature pieces, designed on the canvas and approved before they're built. Sections are small focused components over shared motion primitives.

**Tech Stack:** Next.js 16 (App Router, TypeScript), React 19, `motion` 12, `lenis`, `zod` 4, CSS modules + tokens, `next/font` (Geist), Vitest + Testing Library, Playwright + axe, Lighthouse CI, npm, Vercel, Resend (HTTP API, no SDK).

**Spec:** `docs/superpowers/specs/2026-10-06-lumecrm-website-design.md` (all of it; §5 is the page, §8 the site, §9 Google).

## Global Constraints

- No prices anywhere; CTAs are "Book a demo" and "WhatsApp us" (spec §1).
- Honesty rules (spec §4) and the story rule (§4.1): real captures only; every problem shown beside LUME's fix; numbers measured or the demo's own, never presented as results.
- Copy speaks as LUME; no "we"; no gender guessed; no client names; the founder named in the enquiry section and footer (© 2026 LUME · Kedar Uttam Gurav).
- Logo: `lume-mark.png` as it is, never redrawn. Third-party marks: official unmodified files only (WhatsApp, Google Sheets, Google Calendar, Calendly from LUME's `public/brand`); Zapier and Make by name only.
- One accent, LUME blue `#2A5BFF`, in both themes; meeting sky `#5AB8FF` as its touch; no violet anywhere.
- Motion: springs critically damped by default; interruptible; scroll-linked only where it carries meaning; everything reduced to cross-fades under `prefers-reduced-motion`; no motion blocks reading or input.
- Flawless at every width: 320–4K; no horizontal scroll; tap targets ≥ 44 px; safe-area insets honoured; text ≥ 16 px body on phones; contrast ≥ 4.5:1 in both themes.
- Budgets: LCP ≤ 2.5 s (mid phone, 4G), CLS ≤ 0.05, INP ≤ 200 ms, `/` JS ≤ 180 KB gzipped.
- `/privacy` and `/terms` verbatim from `F:/projects kedar/lume-site`; the Google Limited Use statement on the homepage (spec §9).
- Config in env, never code: `ENQUIRY_TO`, `RESEND_API_KEY`, `LICENCE_URL`, `ENQUIRY_TOKEN`, `NEXT_PUBLIC_WHATSAPP` (`918805895066`).
- Secrets never in the repo or logs; the domain moves only on the owner's say-so, after the verification video.

## Review Focus

- A visitor on a 320 px phone with a large system font (200 %) → nothing overflows, the island and sheet still fit, the form stays one column (Task 11 matrix includes 320 px + `font-size: 200%`).
- JavaScript fails or is slow → the page reads fully: hero composed, sections visible, the form posts as a normal HTML form to `/api/enquire` and the handler answers with a redirect to `/?sent=1#enquire` (Task 9 test with JS disabled).
- Theme switched mid-animation (hero assembling, sheet open) → no flash, captures swap, motion continues from where it is (Task 3/6 tests).
- Both enquiry paths down (licence and Resend) → the visitor lands in WhatsApp with their details written; nothing silently lost (Task 9 test).
- Safari without View Transitions or `scroll-timeline` → the theme change cross-fades and scroll effects use `motion`'s JS fallback (Task 3/6 tests run in WebKit too).

---

### The signature pieces (to design in Task 1, build in Tasks 5–6)

**The Island (navigation).** One floating glass pill, LUME's own island idea turned into the site's nav.

- *Desktop, at the top of the page:* wide (≤ 880 px), top-centre, 14 px from the top: the LUME mark, the section links, the theme switch, Book a demo.
- *Desktop, scrolling down:* it morphs (shared-layout spring, damping 1, response 0.35) into a compact pill: the mark wrapped in a thin progress ring (page progress), the current section's name (cross-fading as sections change), Book a demo. Scrolling up, hovering, or focusing it re-expands it; Esc collapses.
- *Live moments:* during the hero's assembly, the island briefly widens into a notification — "New lead · Instagram · just now" — in step with the tile flying in, then settles. Once per visit, decorative (`aria-hidden`), never under reduced motion.
- *Theme switch inside it:* Auto · Light · Dark, LUME's own words. Changing it runs a View Transition that grows a circle of the new theme from the switch across the whole page (fallback: a 200 ms cross-fade); the mark brightens for a beat.
- *Phone:* the island docks at the bottom, in thumb reach, above `env(safe-area-inset-bottom)`: the mark with its progress ring, the section name, Book a demo. A tap on it rises into a sheet (spring from the island's own shape): the section links, the theme switch, WhatsApp us. Drag down or tap outside or Esc to close; focus is held inside while open and returns to the island.

**The hero — "Lights on".** LUME means light; the hero turns it on.

- *Load:* the headline ("Every lead, answered while it's still warm.") is real text, painted at once (it is the LCP). Behind it, the LUME mark ignites — a soft bloom of LUME blue — and its light sweeps across the headline (a moving mask brightens the letters).
- *The assembly:* below, the real Today capture builds itself. The capture is one image; its six tiles, the day line and Up next are cut from it by the rectangles W1 exported (`today-<theme>.rects.json`) as CSS background slices of that one image. Each piece flies in from the direction of where its data comes from (leads from the sources strip's side, revenue from below, calls from the calendar's side) on curved paths with springs, staggered 60 ms, and locks into place — the finished picture is the untouched capture. The island's "New lead" moment lands with the Leads tile.
- *Pointer light:* the cursor carries a soft light over the stage; the edges of the pieces catch it (a border highlight masked by the pointer's position). On touch, the light drifts slowly on its own.
- *Scroll:* the assembled screen tilts back into A's 3D frame (rotateX 14° → 0, scale 0.94 → 1, scroll-linked), the headline lifts and fades, the glow breathes.
- *Light theme:* the same, with the Porcelain capture; the "light" becomes a cool blue shadow-glow on porcelain.
- *Phone:* headline, sub, both CTAs, then the phone capture assembling from its own rects (≤ 1.6 s total); no pointer light.
- *Reduced motion:* the composed state at once; the glow static.
- *Weight:* one capture image per theme (preloaded for the default), the assembly is transforms and opacity only, no canvas, no video.

---

### Task 1: Design gate — the hero and the island on the canvas

**Files:** the canvas https://claude.ai/artifact/WaomNeRFQWdS5PseyAGv3r (new artboards; nothing in the repo)

- [ ] **Step 1:** Add artboards (each in Dark and Light): Hero — 1 · ignition, 2 · assembling (pieces mid-flight, island notification), 3 · composed, 4 · scrolled (tilted into the frame); Island — wide, compact (with progress ring and section name), notification, expanded on hover, theme change (the circle mid-reveal); Phone — hero composed, island docked, sheet open. Real captures from W1 (`__site__`), uploaded as assets.
- [ ] **Step 2:** Make the hero artboard interactive (Play): a button replays the assembly with the real timings, so the owner sees the motion, not just stills.
- [ ] **Step 3:** Send the owner the link and wait for approval before Tasks 5–6. Tasks 2–4 and 7–10 go ahead meanwhile. Record the approval (or the changes asked) in the ledger.

### Task 2: The repo, its tooling and the pages Google needs

**Files:**
- Create: `package.json`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `.prettierrc`, `vitest.config.ts`, `vitest.setup.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`, `.gitignore`, `README.md`
- Create: `src/app/layout.tsx`, `src/app/page.tsx` (sections stubbed as headings until their tasks), `src/app/privacy/page.tsx`, `src/app/terms/page.tsx`, `src/styles/tokens.css`, `src/styles/global.css`
- Create: `public/lume-mark.png` (copied byte-for-byte from LUME `apps/web/public/lume-mark.png`), `public/brand/*` (WhatsApp, Google Sheets, Google Calendar, Calendly from LUME's `public/brand`, unmodified), `public/screens/*` (W1's output), `src/lib/screens.ts` (typed manifest)
- Test: `src/lib/screens.test.ts`, `e2e/pages.spec.ts`

**Interfaces:**
- Produces: `SCREENS: Record<ScreenName, { light: string; dark: string; width: number; height: number; phone?: { light: string; dark: string; width: number; height: number } }>`; `type ScreenName` (union of W1's names); `rectsFor(theme: "light" | "dark", phone: boolean): Record<TileName, Rect>`.

- [ ] **Step 1:** `npx create-next-app@latest . --ts --app --src-dir --eslint --no-tailwind --import-alias "@/*" --use-npm` in a clone of the repo; pin `next`, `react`, `react-dom` to LUME's versions (`^16.3.8`, `^19.3.0`); add `motion@^12.43.0`, `lenis`, `zod@^4`, dev: `vitest`, `@vitejs/plugin-react`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `@playwright/test`, `@axe-core/playwright`, `prettier`, `@lhci/cli`. Scripts: `dev`, `build`, `start`, `lint` (`eslint . && prettier --check .`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `e2e` (`playwright test`), `lhci` (`lhci autorun`).
- [ ] **Step 2: Failing test** for the manifest:

```ts
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SCREENS, rectsFor } from "./screens";

describe("the captures the page shows", () => {
  it("every screen has both themes on disk", () => {
    for (const [name, s] of Object.entries(SCREENS))
      for (const f of [s.light, s.dark, ...(s.phone ? [s.phone.light, s.phone.dark] : [])])
        expect([name, existsSync(path.join("public", f))]).toEqual([name, true]);
  });
  it("the hero's pieces lie inside the Today capture", () => {
    for (const theme of ["light", "dark"] as const) {
      const r = rectsFor(theme, false);
      for (const [k, b] of Object.entries(r)) {
        expect([k, b.x >= 0 && b.y >= 0 && b.x + b.w <= 1440 && b.y + b.h <= 900]).toEqual([k, true]);
      }
    }
  });
});
```

- [ ] **Step 3:** Implement `screens.ts` from `public/screens/manifest.json` and the `*.rects.json` files (imported as JSON; `resolveJsonModule`). Run `npm test` → PASS.
- [ ] **Step 4:** `tokens.css` — the two themes as LUME's (read LUME `apps/web/src/styles/tokens.css` and copy the colour, radius, shadow and type tokens the site uses; Dark's ground is `#07080B`), selected by `:root[data-theme="dark"]` / `[data-theme="light"]`, plus the system-dark block guarded by `:root:not([data-theme="light"])` under `@media (prefers-color-scheme: dark)`; `global.css` sets `body` background and colour from tokens, `color-scheme`, font smoothing, `text-size-adjust: 100%`, and `overflow-x: clip` on `html`.
- [ ] **Step 5:** Privacy and terms: copy the text of `F:/projects kedar/lume-site/privacy/index.html` and `terms/index.html` into the two pages verbatim (headings, lists, links; only the wrapper markup changes); a Playwright test asserts each page contains the exact Limited Use sentence and the scope `calendar.events.owned.readonly`.
- [ ] **Step 6:** CI: on push and PR — `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npx playwright install --with-deps chromium webkit`, `npm run build`, `npm run e2e`, `npm run lhci`.
- [ ] **Step 7: Commit** `git commit -m "chore: the site's repo — Next.js, tokens, captures, privacy and terms as Google saw them"`

### Task 3: Light and dark, exactly like LUME

**Files:**
- Create: `src/theme/theme-script.ts` (the inline pre-paint script as a string), `src/theme/ThemeProvider.tsx`, `src/theme/ThemeSwitch.tsx`, `src/theme/theme.module.css`, `src/components/Screen.tsx`, `src/components/screen.module.css`
- Modify: `src/app/layout.tsx` (script in `<head>`, provider)
- Test: `src/theme/ThemeSwitch.test.tsx`, `src/components/Screen.test.tsx`, `e2e/theme.spec.ts`

**Interfaces:**
- Produces: `useTheme(): { choice: "auto" | "light" | "dark"; resolved: "light" | "dark"; set(c, origin?: { x: number; y: number }): void }`; `<ThemeSwitch />` (radio group, LUME's words "Auto", "Light", "Dark"); `<Screen name={ScreenName} alt={string} phone? priority? className? />` rendering both theme images, CSS showing the current one.

- [ ] **Step 1: Failing tests**

```tsx
// ThemeSwitch.test.tsx
it("Auto · Light · Dark: the choice is remembered and the page follows", async () => {
  render(<ThemeProvider><ThemeSwitch /></ThemeProvider>);
  await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("lume-site-theme")).toBe("dark");
  await userEvent.click(screen.getByRole("radio", { name: "Auto" }));
  expect(document.documentElement.dataset.theme).toBe(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
});
it("works with storage blocked", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  render(<ThemeProvider><ThemeSwitch /></ThemeProvider>);
  await userEvent.click(screen.getByRole("radio", { name: "Light" }));
  expect(document.documentElement.dataset.theme).toBe("light");
});
// Screen.test.tsx
it("carries both themes' captures, sized, with the alt once", () => {
  render(<Screen name="today" alt="LUME's Today" />);
  const imgs = document.querySelectorAll("img");
  expect([...imgs].map((i) => i.getAttribute("src"))).toEqual([SCREENS.today.light, SCREENS.today.dark]);
  expect(screen.getAllByAltText("LUME's Today")).toHaveLength(1);
  expect(imgs[1]!.getAttribute("alt")).toBe("");
  expect(imgs[0]!.getAttribute("width")).toBe(String(SCREENS.today.width));
});
```

```ts
// e2e/theme.spec.ts
test("no flash: a remembered Dark paints dark before any script runs", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lume-site-theme", "dark"));
  await page.goto("/", { waitUntil: "commit" });
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
});
test("switching swaps every capture", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("radio", { name: "Light" }).first().click();
  const shown = await page.locator("img[data-theme-img]").evaluateAll((els) =>
    els.filter((e) => getComputedStyle(e).display !== "none").map((e) => (e as HTMLImageElement).dataset.themeImg));
  expect(new Set(shown)).toEqual(new Set(["light"]));
});
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.** The pre-paint script (inlined with `dangerouslySetInnerHTML` in `<head>`, before CSS paints):

```ts
export const THEME_KEY = "lume-site-theme";
export const themeScript = `(function(){try{var c=localStorage.getItem("${THEME_KEY}")}catch(e){}
var d=c==="dark"||c==="light"?c:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
document.documentElement.dataset.theme=d;document.documentElement.dataset.choice=c||"auto"})()`;
```

`set(choice, origin)`: resolve, then if `document.startViewTransition` and motion allowed, set `--vt-x/--vt-y` from `origin` and run the swap inside the transition; CSS:

```css
::view-transition-new(root) { animation: reveal 520ms cubic-bezier(.2,.8,.2,1); }
::view-transition-old(root) { animation: none; }
@keyframes reveal { from { clip-path: circle(0 at var(--vt-x) var(--vt-y)); } to { clip-path: circle(150vmax at var(--vt-x) var(--vt-y)); } }
@media (prefers-reduced-motion: reduce) { ::view-transition-new(root) { animation: fade 200ms ease; } }
```

Auto follows `matchMedia` changes live. `Screen`: two `<img data-theme-img="light|dark">` with `width`/`height`, `decoding="async"`, `loading={priority ? "eager" : "lazy"}`, `fetchPriority={priority ? "high" : "auto"}`; the dark one `alt=""`; CSS hides the one not matching `:root[data-theme]`. (Inside the Island, the switch passes its own centre as `origin`.)
- [ ] **Step 4:** Run — PASS (unit + e2e in chromium and webkit).
- [ ] **Step 5: Commit** `git commit -m "feat: light and dark like LUME's — remembered, no flash, every capture swaps"`

### Task 4: Motion primitives

**Files:**
- Create: `src/motion/SmoothScroll.tsx` (Lenis, off under reduced motion and on touch-only devices where native scroll is better), `src/motion/useReducedMotion.ts`, `src/motion/Reveal.tsx` (enter-on-view, spring, once), `src/motion/springs.ts`, `src/motion/useSectionProgress.ts`
- Test: `src/motion/Reveal.test.tsx`, `src/motion/useSectionProgress.test.ts`

**Interfaces:**
- Produces: `SPRING = { type: "spring", bounce: 0, duration: 0.5 } as const`, `SPRING_SOFT = { type: "spring", bounce: 0.12, duration: 0.6 } as const`; `<Reveal as? delay? y? children />`; `useSectionProgress(ref): MotionValue<number>` (0 → 1 across the section's passage); `useActiveSection(ids: string[]): string | null`.

- [ ] **Step 1: Failing tests** — Reveal renders children visible immediately when `prefers-reduced-motion: reduce` (mock `matchMedia`), and with motion starts at `opacity: 0` and reaches 1 after an IntersectionObserver entry (mock observer); `useActiveSection` returns the id whose section covers the viewport's 40 % line.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement with `motion/react` (`useInView`, `useScroll`, `useTransform`). **Step 4:** PASS. **Step 5: Commit** `git commit -m "feat: motion primitives — springs, reveal, section progress, smooth scroll that steps aside"`

### Task 5: The Island (after Task 1's approval)

**Files:**
- Create: `src/components/island/Island.tsx`, `island.module.css`, `IslandSheet.tsx`, `ProgressRing.tsx`, `useIslandState.ts`
- Modify: `src/app/page.tsx` (mount; a skip link "Skip to the page" before it)
- Test: `src/components/island/useIslandState.test.ts`, `Island.test.tsx`, `e2e/island.spec.ts`

**Interfaces:**
- Consumes: `useActiveSection`, `SPRING`, `ThemeSwitch`, `useTheme`.
- Produces: `islandState(input: { y: number; lastY: number; hover: boolean; focus: boolean; phone: boolean; notifying: boolean }): "wide" | "compact" | "notify" | "dock"`; `<Island sections={{ id: string; label: string }[]} />`; a window event `lume:notify` `{ detail: { text: string } }` the hero dispatches.

- [ ] **Step 1: Failing tests**

```ts
describe("the island's state", () => {
  it("wide at the top, compact going down, wide again going up or when touched", () => {
    expect(islandState({ y: 0, lastY: 0, hover: false, focus: false, phone: false, notifying: false })).toBe("wide");
    expect(islandState({ y: 600, lastY: 500, hover: false, focus: false, phone: false, notifying: false })).toBe("compact");
    expect(islandState({ y: 580, lastY: 600, hover: false, focus: false, phone: false, notifying: false })).toBe("wide");
    expect(islandState({ y: 900, lastY: 800, hover: true, focus: false, phone: false, notifying: false })).toBe("wide");
  });
  it("a notification wins over compact; a phone is always docked", () => {
    expect(islandState({ y: 40, lastY: 20, hover: false, focus: false, phone: false, notifying: true })).toBe("notify");
    expect(islandState({ y: 0, lastY: 0, hover: false, focus: false, phone: true, notifying: true })).toBe("dock");
  });
});
```

```tsx
it("on a phone the dock opens a sheet with the links, the theme and WhatsApp; Esc returns focus", async () => {
  setViewport(390);
  render(<ThemeProvider><Island sections={SECTIONS} /></ThemeProvider>);
  const dock = screen.getByRole("button", { name: /Menu/ });
  await userEvent.click(dock);
  const sheet = screen.getByRole("dialog", { name: "Menu" });
  expect(within(sheet).getAllByRole("link").map((a) => a.textContent)).toContain("Follow-up");
  expect(within(sheet).getByRole("radio", { name: "Dark" })).toBeInTheDocument();
  expect(within(sheet).getByRole("link", { name: /WhatsApp/ })).toHaveAttribute("href", "https://wa.me/918805895066");
  await userEvent.keyboard("{Escape}");
  expect(dock).toHaveFocus();
});
```

```ts
// e2e/island.spec.ts — desktop and 390 px, chromium + webkit
test("the island never covers the hero's buttons and never makes the page scroll sideways", async ({ page }) => { … });
test("Book a demo from the island lands on the form with the name field focused", async ({ page }) => { … });
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.** `<header role="banner">` holding `<nav aria-label="Main">`; the pill is one `motion.div` with `layout` and `SPRING`; its children swap with `AnimatePresence mode="popLayout"`; compact shows `<ProgressRing value={scrollYProgress} />` around the mark and the active section's label (`aria-live="polite"` off — the label is visual, the links carry the semantics); `notify` comes from `lume:notify` for 2.4 s, once, `aria-hidden`. Desktop placement: `position: fixed; top: max(14px, env(safe-area-inset-top)); left: 50%; translate: -50% 0;` glass: `background: color-mix(in oklab, var(--surface) 72%, transparent); backdrop-filter: blur(18px) saturate(180%);` with the reduced-transparency fallback (solid surface). Phone (`max-width: 760px`): `bottom: max(12px, env(safe-area-inset-bottom)); left: 12px; right: 12px;` a single `<button aria-expanded aria-controls>` "Menu" containing the ring + section name, and the separate Book a demo link; the sheet is a `role="dialog" aria-modal` with focus trap, drag-to-close (`drag="y"`, dismiss past 80 px or velocity > 600 px/s, projection per apple-design §6), and the full-window scrim. Page content gets `padding-bottom` for the dock on phones.
- [ ] **Step 4:** Run — PASS. **Step 5: Commit** `git commit -m "feat: the Island — LUME's island as the site's navigation, docked for thumbs on phones"`

### Task 6: The hero — "Lights on" (after Task 1's approval)

**Files:**
- Create: `src/components/hero/Hero.tsx`, `hero.module.css`, `Assembly.tsx`, `assembly.ts` (pure geometry), `PointerLight.tsx`, `Ignition.tsx`
- Test: `src/components/hero/assembly.test.ts`, `Hero.test.tsx`, `e2e/hero.spec.ts`

**Interfaces:**
- Consumes: `rectsFor`, `SCREENS.today`, `useTheme`, `useReducedMotion`, `SPRING`, `lume:notify`.
- Produces: `pieces(rects: Record<string, Rect>, frame: { w: number; h: number }): Piece[]` where `type Piece = { name: string; rect: Rect; from: { x: number; y: number; rotate: number }; delay: number; bgPos: string; bgSize: string }`.

- [ ] **Step 1: Failing tests**

```ts
describe("the hero's assembly", () => {
  const rects = { greeting: { x: 296, y: 100, w: 1086, h: 60 }, day: { x: 294, y: 176, w: 537, h: 226 }, leads: { x: 845, y: 176, w: 262, h: 226 }, revenue: { x: 1121, y: 176, w: 262, h: 226 } };
  it("each piece shows exactly its part of the one capture", () => {
    const p = pieces(rects, { w: 1440, h: 900 }).find((x) => x.name === "leads")!;
    expect(p.bgPos).toBe("-845px -176px");
    expect(p.bgSize).toBe("1440px 900px");
  });
  it("leads fly in from the sources' side, revenue from below, staggered 60 ms in reading order", () => {
    const ps = pieces(rects, { w: 1440, h: 900 });
    expect(ps.find((x) => x.name === "leads")!.from.x).toBeLessThan(0);
    expect(ps.find((x) => x.name === "revenue")!.from.y).toBeGreaterThan(0);
    expect(ps.map((x) => x.delay)).toEqual([0, 0.06, 0.12, 0.18]);
  });
});
```

```tsx
it("with reduced motion the hero is the composed capture at once, the headline first", () => {
  mockReducedMotion(true);
  render(<ThemeProvider><Hero /></ThemeProvider>);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Every lead, answered while it’s still warm.");
  expect(screen.getByAltText(/LUME's Today/)).toBeVisible();
  expect(document.querySelectorAll("[data-piece]")).toHaveLength(0);
});
```

```ts
// e2e/hero.spec.ts
test("the headline is the LCP and paints before the assembly", async ({ page }) => { /* PerformanceObserver largest-contentful-paint element is the h1 */ });
test("after the assembly the pieces line up with the capture to the pixel", async ({ page }) => { /* screenshot the composed hero frame; compare to the plain capture with maxDiffPixelRatio 0.002 */ });
test("at 320 px the hero fits: both buttons visible, no sideways scroll", async ({ page }) => { … });
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.** `assembly.ts`:

```ts
export type Rect = { x: number; y: number; w: number; h: number };
export type Piece = { name: string; rect: Rect; from: { x: number; y: number; rotate: number }; delay: number; bgPos: string; bgSize: string };
/** Where each piece's data comes from (spec: sources on the left, money from below, calls from the right). */
const ORIGIN: Record<string, { x: number; y: number; rotate: number }> = {
  greeting: { x: 0, y: -60, rotate: 0 }, day: { x: -220, y: 80, rotate: -4 }, work: { x: -260, y: 160, rotate: -3 },
  leads: { x: -340, y: -40, rotate: -6 }, revenue: { x: 0, y: 260, rotate: 3 }, pipeline: { x: 120, y: 220, rotate: 2 },
  calendar: { x: 340, y: -20, rotate: 5 }, team: { x: 300, y: 200, rotate: 4 }, replies: { x: 380, y: 120, rotate: 6 },
};
export function pieces(rects: Record<string, Rect>, frame: { w: number; h: number }): Piece[] {
  return Object.entries(rects)
    .sort(([, a], [, b]) => a.y - b.y || a.x - b.x)
    .map(([name, rect], i) => ({
      name, rect,
      from: ORIGIN[name] ?? { x: 0, y: 120, rotate: 0 },
      delay: Math.round(i * 60) / 1000,
      bgPos: `-${rect.x}px -${rect.y}px`,
      bgSize: `${frame.w}px ${frame.h}px`,
    }));
}
```

`Assembly.tsx`: a 1440×900 stage scaled to its container (`transform: scale(var(--k))`, `--k` from a ResizeObserver), the capture as a faint base (opacity 0.06 → 1 when the last piece lands, then the pieces unmount so the composed state is the real `<Screen priority>`), each piece a `motion.div data-piece` with `backgroundImage: url(capture)`, `bgPos`, `bgSize`, animating from `from` to 0 with `SPRING_SOFT` after `delay + 0.35 s`; when the `leads` piece lands, dispatch `lume:notify` "New lead · Instagram · just now". `Ignition.tsx`: the mark (`next/image`, `lume-mark.png`) scaling 0.82 → 1 with a radial bloom; the headline's light sweep is a `mask-image: linear-gradient(...)` whose position animates once (CSS `@property --sweep`). `PointerLight.tsx`: sets `--px/--py` on the stage from `pointermove` (rAF-throttled); pieces' `::after` border uses `radial-gradient(240px at var(--px) var(--py), color-mix(in oklab, var(--accent) 55%, transparent), transparent)` as a mask; on `pointer: coarse`, a slow CSS drift instead. Scroll: `useScroll({ target: heroRef, offset: ["start start", "end start"] })` → `rotateX` 14→0 deg, `scale` 0.94→1, headline `y` 0→-40 and `opacity` 1→0.2. Phone (≤ 760 px): uses `rectsFor(theme, true)` and the phone capture; delays halved; no pointer light. Theme change mid-assembly: pieces keep their motion values and only swap `backgroundImage`.
- [ ] **Step 4:** Run — PASS (unit + e2e chromium/webkit at 320, 390, 768, 1440, 2560).
- [ ] **Step 5: Commit** `git commit -m "feat: the hero — LUME lights up and Today builds itself from its own pieces"`

### Task 7: The story, part one — problem, follow-up, actions

**Files:**
- Create: `src/sections/Sources.tsx`, `Problem.tsx`, `FollowUp.tsx`, `Actions.tsx` (+ a `.module.css` each), `src/content/copy.ts` (every line of copy for these sections, as constants)
- Test: `src/sections/sections1.test.tsx`, `e2e/actions.spec.ts`

**Interfaces:**
- Consumes: `Screen`, `Reveal`, `useSectionProgress`, `SPRING`.
- Produces: each section a component with `id` (`sources`, `problem`, `follow-up`, `actions`) and a `label` exported for the Island.

Copy (exact):
- Sources: "Leads arrive from where you already are" — chips: Instagram & Facebook forms · Your website · Google Sheets (logo) · Calendly (logo) · Zapier & Make · A spreadsheet you already have.
- Problem: "Your leads are in five places." / "The first reply comes days later." / "And when your best salesperson leaves, the leads go with their phone." Then "21×" — "more likely to qualify a web lead reached within 5 minutes than within 30." Footnote: "Oldroyd, Lead Response Management Study, MIT and InsideSales, 2007."
- Follow-up (A's section): eyebrow "Follow-up", "Nobody waits. Nothing slips.", the paragraph and three ticks from spec §5 item 5, capture `today` + a WhatsApp bubble (`public/brand/whatsapp.svg`, "WhatsApp · ready to send", "Hi Ananya, thanks for asking about the wedding package. Is Thursday at 4 good for a quick call?").
- Actions: "What your team does in LUME" with spec §5.1's nine rows (label, key chip, capture). Desktop: sticky two columns — the list on the left (the active row's key chip lights; a thin rail fills with progress), the capture on the right cross-fading per row; the active row follows scroll (`useSectionProgress` mapped to 9 steps) or a click. Phone: a horizontal snap carousel of cards (capture over label), swipe with momentum, dots below.

- [ ] **Step 1: Failing tests** — every section renders its exact heading text; Problem's footnote names the study; Actions lists nine rows whose captures exist in `SCREENS`; clicking row 4 ("Win a deal") shows the `action-won` capture; arrow keys move between rows (`roving` behaviour: one Tab stop).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `git commit -m "feat: the problem, follow-up on WhatsApp, and nine things a team does in LUME"`

### Task 8: The story, part two — a lead's day to the footer

**Files:**
- Create: `src/sections/LeadsDay.tsx`, `Phone.tsx`, `RepDashboards.tsx`, `CaughtEarly.tsx`, `Analytics.tsx`, `Security.tsx`, `OwnServer.tsx`, `Faq.tsx`, `Footer.tsx` (+ css each); extend `src/content/copy.ts`
- Test: `src/sections/sections2.test.tsx`, `e2e/sections.spec.ts`

Copy and behaviour (exact, from spec §5):
- **A lead's day:** the four steps (9:02 am "A form is filled", 9:03 am "The right person knows", 9:05 am "WhatsApp in one tap", Thursday, 4 pm "The call, then won") with B's bodies; a line draws between cards as they enter (SVG path `pathLength` 0→1 on `useSectionProgress`); the last card in LUME blue.
- **On your phone:** "Your reps carry LUME in their pocket." Three phone captures (today, leads, drawer — `phone` variants) in a device frame (CSS, no image), fanning out (−8°, 0°, 8°) on scroll; on phones, one centred frame with a swipe.
- **Every rep, their own dashboard:** "Each rep sees their own day and numbers. You see everyone's." Points from spec §5 item 9; `today-rep` + `me` captures from the left, `team` from the right, meeting in the middle (x ±120 → 0 on scroll).
- **Caught early:** "LUME spots trouble before it costs you." Four pairs: `caught-no-touch` → "Back on its owner's Today, with a follow-up."; `caught-needs-you` → "One tap gives the overdue work to someone free."; `caught-source` → "Cost per lead beside win rate, so the budget moves."; `caught-goal` → "The pace and the gap, while there's time to close it." Each pair: the warning chip amber, turning green with a tick as it passes the viewport's middle (`useSectionProgress` per pair). Under reduced motion: both states shown side by side.
- **Analytics:** C's section exactly — the `overview` capture under a fade (dark: `linear-gradient(180deg, transparent, rgba(10,13,22,.96) 60%)`; light: the Porcelain equivalent), "Analytics that read like a colleague's note.", four chips "Speed pays off", "Referrals punch above their weight", "Webinars cost more than they return", "Most leads arrive after 7 pm", and a small label "From the demo business".
- **When someone leaves, your leads don't:** four cards (Roles decide who sees which leads · Exports locked, and approved when needed · Every download traceable · An alert when someone reads far more than usual · Offboarding hands their leads on — five items, the fifth full-width), `security` and `trace` captures behind, low opacity.
- **Your own LUME:** A's three cards (own server; hard to walk out with; fast at a million leads) and the counters 1,000,000 / 8 ms / 50,000 counting up once (`useInView`, 900 ms, eased), static under reduced motion.
- **FAQ:** the seven questions and answers from spec §5 item 14 as `<details>`/`<summary>` (native, keyboard and no-JS friendly), one open at a time via a `name` attribute group, animated height with `interpolate-size: allow-keywords` where supported.
- **Footer:** spec §5 item 16.

- [ ] **Step 1: Failing tests** — exact headings; the analytics section's four chips and the "From the demo business" label; FAQ answers present in the HTML without JS; counters show final numbers under reduced motion; every capture referenced exists.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `git commit -m "feat: a lead's day, the phone, every rep's dashboard, caught early, analytics, security, FAQ"`

### Task 9: The enquiry — form, route, fallbacks

**Files:**
- Create: `src/sections/Enquire.tsx`, `enquire.module.css`, `src/lib/enquiry.ts` (zod schema shared by form and route; `whatsappLink(details)`), `src/app/api/enquire/route.ts`, `src/lib/send.ts` (`fileWithLicence`, `emailOwner`)
- Test: `src/lib/enquiry.test.ts`, `src/app/api/enquire/route.test.ts`, `src/sections/Enquire.test.tsx`, `e2e/enquire.spec.ts`

**Interfaces:**
- Consumes: env `LICENCE_URL`, `ENQUIRY_TOKEN`, `RESEND_API_KEY`, `ENQUIRY_TO`, `NEXT_PUBLIC_WHATSAPP`.
- Produces: `enquirySchema` (fields `name`, `business`, `whatsapp`, `email?`, `teamSize` in `"1" | "2-5" | "6-20" | "21+"`, `how?`, plus `website` honeypot and `t` (ms since render)); `normaliseWhatsapp(raw: string, defaultCountry = "91"): string | null` (→ `+<digits>` E.164 or null); `whatsappLink(d): string` (`https://wa.me/<NEXT_PUBLIC_WHATSAPP>?text=<encoded details>`); `POST /api/enquire` → `200 { ok: true, filed: boolean, emailed: boolean }` | `400 { error }` | `502 { ok: false, whatsapp: string }`; with `Accept: text/html` (no-JS form post) → `303` to `/?sent=1#enquire` or `/?retry=1#enquire`.

- [ ] **Step 1: Failing tests**

```ts
// enquiry.test.ts
it("reads Indian numbers as people type them", () => {
  expect(normaliseWhatsapp("98123 45678")).toBe("+919812345678");
  expect(normaliseWhatsapp("+91 98123-45678")).toBe("+919812345678");
  expect(normaliseWhatsapp("0091 9812345678")).toBe("+919812345678");
  expect(normaliseWhatsapp("+44 7700 900123")).toBe("+447700900123");
  expect(normaliseWhatsapp("12345")).toBeNull();
});
// route.test.ts
const ok = { name: "Ananya Rao", business: "Petal & Plate Studio", whatsapp: "98123 45678", teamSize: "2-5", website: "", t: 9000 };
it("files with the licence server and emails the owner; either alone is enough", async () => {
  mockFetch({ licence: 201, resend: 200 });
  expect(await (await POST(req(ok))).json()).toEqual({ ok: true, filed: true, emailed: true });
  mockFetch({ licence: 500, resend: 200 });
  expect(await (await POST(req(ok))).json()).toEqual({ ok: true, filed: false, emailed: true });
  mockFetch({ licence: 201, resend: 500 });
  expect(await (await POST(req(ok))).json()).toEqual({ ok: true, filed: true, emailed: false });
});
it("both down: says so and hands back the WhatsApp link with the details written", async () => {
  mockFetch({ licence: 500, resend: 500 });
  const r = await POST(req(ok));
  expect(r.status).toBe(502);
  const { whatsapp } = await r.json();
  expect(whatsapp).toMatch(/^https:\/\/wa\.me\/918805895066\?text=/);
  expect(decodeURIComponent(whatsapp)).toContain("Petal & Plate Studio");
});
it("a bot is thanked and dropped: honeypot filled, or sent in under 3 seconds", async () => {
  const calls = mockFetch({ licence: 201, resend: 200 });
  expect((await POST(req({ ...ok, website: "spam.example" }))).status).toBe(200);
  expect((await POST(req({ ...ok, t: 800 }))).status).toBe(200);
  expect(calls()).toBe(0);
});
it("a form posted without JavaScript is redirected back to the form", async () => {
  mockFetch({ licence: 201, resend: 200 });
  const r = await POST(formReq(ok));
  expect([r.status, r.headers.get("location")]).toEqual([303, "/?sent=1#enquire"]);
});
it("never sends the email address or the token to the browser, and never logs them", async () => { /* spy console; assert no ENQUIRY_TO / token values in responses or logs */ });
```

```tsx
// Enquire.test.tsx
it("five fields and one optional line; errors in words beside the field", async () => { … });
it("sent: the form becomes LUME's promise", async () => { /* "LUME's founder will message you on WhatsApp soon." */ });
it("both paths down: WhatsApp opens with the details", async () => { /* window.location.assign called with the wa.me link */ });
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** `send.ts`:

```ts
export async function fileWithLicence(d: Enquiry, env = process.env): Promise<boolean> {
  if (!env.LICENCE_URL || !env.ENQUIRY_TOKEN) return false;
  try {
    const r = await fetch(`${env.LICENCE_URL}/v1/enquiries`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.ENQUIRY_TOKEN}` },
      body: JSON.stringify({ name: d.name, business: d.business, whatsapp: d.whatsapp, email: d.email ?? null, teamSize: d.teamSize, how: d.how ?? null }),
      signal: AbortSignal.timeout(6000),
    });
    return r.status === 201;
  } catch {
    return false;
  }
}
export async function emailOwner(d: Enquiry, env = process.env): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.ENQUIRY_TO) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: "LUME website <enquiries@lumecrm.in>",
        to: [env.ENQUIRY_TO],
        subject: `New enquiry: ${d.business}`,
        text: [`${d.name} — ${d.business}`, `WhatsApp: ${d.whatsapp}`, d.email ? `Email: ${d.email}` : "", `Team: ${d.teamSize}`, d.how ? `How leads reach them: ${d.how}` : ""].filter(Boolean).join("\n"),
      }),
      signal: AbortSignal.timeout(6000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
```

The route runs both with `Promise.all`, logs only outcomes (`{ filed, emailed }`), never the body. The form: `<form method="post" action="/api/enquire">` (works without JS), enhanced with `onSubmit` → `fetch`; inline errors from the shared schema; the honeypot is a visually hidden field labelled "Leave this empty" with `tabIndex={-1}` and `autoComplete="off"`; `t` set from render time. Fields: Your name · Business · WhatsApp number (`inputMode="tel"`, `autoComplete="tel"`) · Email (optional, `autoComplete="email"`) · Team size (radio chips: Just me / 2–5 / 6–20 / 21+) · How do leads reach you today? (optional). Button "Book my demo"; beside it "Or message +91 88058 95066" on WhatsApp. On phones the panel is one column; inputs 16 px so iOS doesn't zoom.
- [ ] **Step 4:** PASS. **Step 5: Commit** `git commit -m "feat: enquiries — to the licence dashboard and the owner's inbox, WhatsApp if both are down"`

### Task 10: Search, sharing and structured data

**Files:**
- Modify: `src/app/layout.tsx` (metadata: title "LUME — lead management for teams that sell on WhatsApp", description, `metadataBase: https://lumecrm.in`, Open Graph, Twitter card, theme-color both themes, icons from `lume-mark.png`)
- Create: `src/app/opengraph-image.tsx` (1200×630: the composed hero — mark, headline, the Today capture — rendered with `next/og` from the Dark capture), `src/app/sitemap.ts`, `src/app/robots.ts`, `src/components/JsonLd.tsx` (`SoftwareApplication` + `Organization`, no `offers`)
- Test: `src/app/seo.test.ts`

- [ ] **Step 1: Failing test** — metadata title/description as above; sitemap lists `/`, `/privacy`, `/terms`; JSON-LD has `@type: "SoftwareApplication"`, `applicationCategory: "BusinessApplication"`, and no `offers`/`price`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `git commit -m "feat: search and sharing — titles, the hero as the share image, structured data with no price"`

### Task 11: Flawless everywhere — the quality pass

**Files:**
- Create: `e2e/matrix.spec.ts`, `e2e/a11y.spec.ts`, `e2e/nojs.spec.ts`, `lighthouserc.json`
- Modify: any component the matrix finds wanting

- [ ] **Step 1: The matrix** (chromium and webkit; both themes; motion on and reduced): widths 320, 360, 375, 390, 414, 430 (phones, portrait), 667 and 844 landscape, 768, 820, 1024 (tablets), 1280, 1366, 1440, 1536, 1920, 2560. For each: `document.documentElement.scrollWidth <= innerWidth`; no element's box crosses the viewport's right edge (`getBoundingClientRect().right <= innerWidth + 0.5` for every element except the hero's off-screen pieces before they land); every button/link ≥ 44 × 44 at phone widths; the Island never overlaps the hero CTAs; a full-page screenshot saved to `e2e/__review__/` for the owner (unmasked). Plus 320 px with `html { font-size: 200% }`.
- [ ] **Step 2: Accessibility** — axe in both themes, zero violations; keyboard: Tab order follows the page, every control reachable, focus visible on every surface (glass included); the sheet traps and returns focus; `prefers-reduced-motion` honoured (no transform animation observed over 2 s); `prefers-reduced-transparency` makes glass solid; `prefers-contrast: more` adds borders.
- [ ] **Step 3: No JavaScript** — with JS disabled the page shows every section and capture, the FAQ opens, and the form posts (303 back with `sent=1`).
- [ ] **Step 4: Lighthouse budgets** (`lighthouserc.json`, mobile preset, 3 runs): performance ≥ 0.9, LCP ≤ 2500, CLS ≤ 0.05, TBT ≤ 200, total JS on `/` ≤ 180 KB gzipped; accessibility = 1; SEO ≥ 0.95.
- [ ] **Step 5:** Fix every finding; rerun until green; list fixes in the ledger. Look at every review screenshot (both themes, phone and desktop) before calling it done.
- [ ] **Step 6: Commit** `git commit -m "test: every screen size, both themes, reduced motion, no JavaScript, and Lighthouse budgets"`

### Task 12: Deploy for review, then the switch-over

- [ ] **Step 1:** Create the Vercel project `lume-landing` from the repo (owner's Vercel account, the team that holds `lume-site`); env (Production + Preview): `LICENCE_URL=https://license.lumecrm.in`, `NEXT_PUBLIC_WHATSAPP=918805895066`, `ENQUIRY_TO` = the owner's email (typed by the owner or piped, never committed), `ENQUIRY_TOKEN` piped from the licence server's secret file without printing (`ssh lumedev cat /root/lume-licence/secrets/enquiry.token | npx vercel@latest env add ENQUIRY_TOKEN production`), `RESEND_API_KEY` added by the owner.
- [ ] **Step 2:** Deploy to the preview URL; send the owner the link plus the review screenshots; one real test enquiry end to end (it appears in license.lumecrm.in → Enquiries and in the inbox; then mark it "Not a fit" and note "test").
- [ ] **Step 3:** On the owner's say-so (after the Google video): move `lumecrm.in` and `www.lumecrm.in` from the `lume-site` project to `lume-landing` (Vercel → Domains; no DNS change), verify `https://lumecrm.in`, `/privacy`, `/terms` all 200 with the same Google wording, and keep `lume-site` (unlinked) for a week as the way back.
- [ ] **Step 4:** Update LUME's memory and the Google runbook: the homepage is now the product site; `/privacy` and `/terms` unchanged.
