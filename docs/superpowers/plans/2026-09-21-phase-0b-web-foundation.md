# Phase 0B — Web Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the approved LUME design (Porcelain/Obsidian, motion, sound, shell, sign-in) into the real `apps/web` foundation that every later screen is built from.

**Architecture:** Next.js 16 App Router in `apps/web`. Design tokens are CSS custom properties per theme. Components are React 19 + CSS Modules. Motion uses `motion/react` with springs defined once in `src/lib/motion.ts`, and sounds are synthesised with Web Audio in `src/lib/sound.ts`. The theme preference lives in a cookie, is resolved on the server (no flash), and `system` is resolved in CSS. Unit tests run in Vitest + jsdom. E2E, visual snapshots and axe checks run in Playwright inside the toolbox container (same image locally and in CI, so screenshots match).

**Tech Stack:** Next.js 16, React 19, TypeScript 5, CSS Modules, motion 12, radix-ui (Dialog), lucide-react, Inter 4.1 (self-hosted WOFF2), Vitest 3 + @testing-library/react + jsdom, Playwright + @axe-core/playwright.

**Spec:** `docs/superpowers/specs/2026-09-21-lume-frontend-design.md` (visual source of truth, with the prototypes in `docs/design/prototypes/`) and `docs/superpowers/specs/2026-09-21-phase-0-foundations-design.md` §1.

## Global Constraints

- Work on `main` only. Run the full suite before every push, and watch CI afterwards.
- Everything runs through `scripts/dev.sh` on the build host (see Plan 0A's Global Constraints: no host installs, 127.0.0.1-only ports, resource caps). `scripts/dev.sh add …` for dependencies, `scripts/dev.sh fmt` for formatting.
- CSP: no inline scripts (nonces via `src/proxy.ts`), no third-party origins. Fonts self-hosted. No Google Fonts, no CDNs.
- Colour only through tokens (`var(--…)`), never raw hex in components. Colour meaning is fixed: red = overdue/error/lost/high risk, amber = due soon/live/needs attention, violet = meetings, green = done/won/growth, blue = brand/action/selection, WhatsApp green only on WhatsApp actions, grey = neutral.
- Sounds only for accomplishments: `done`, `sent`, `won`, `cleared`. Clicks, hover, navigation, toggles, panels, snooze, undo, sign-in and incoming notifications are silent.
- Motion: springs from `src/lib/motion.ts` only. Interruptible. `prefers-reduced-motion` → opacity cross-fades, no slides or bounces.
- Anything a role can't use is not rendered (absent, not disabled).
- Scrollbars are the LUME custom ones (thin, token-coloured, visible on hover/scroll) in both themes.
- Sidebar lockup: mark + **LUME** (bold) on top, client name below.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Map (all under `apps/web/` unless noted)

| Path | Responsibility |
|---|---|
| `vitest.config.ts`, `vitest.setup.ts` | jsdom unit test project |
| `playwright.config.ts`, `e2e/*.spec.ts` | E2E, visual snapshots, axe |
| `public/fonts/InterVariable.woff2`, `InterVariable-Italic.woff2`, `LICENSE-Inter.txt` | Self-hosted Inter 4.1 |
| `src/styles/tokens.css` | Theme tokens (Porcelain, Obsidian, system) + shared scales |
| `src/styles/base.css` | Reset, body, typography roles, focus ring, scrollbars, reduced motion/transparency/contrast |
| `src/styles/tokens.test.ts` | Token parity + contrast checks |
| `src/lib/contrast.ts` | WCAG contrast maths |
| `src/lib/motion.ts` | Spring tokens, CSS `linear()` generation, Motion configs, projection, rubber-band |
| `src/lib/sound.ts`, `src/components/feedback/SoundProvider.tsx` | Achievement sounds |
| `src/lib/theme.ts`, `src/components/theme/ThemeToggle.tsx` | Theme preference cookie + toggle |
| `src/lib/useDelayedFlag.ts` | Show skeletons only after 150 ms |
| `src/components/ui/*` | Button, IconButton, Kbd, Chip, Avatar, SegmentedControl, Switch, CheckCircle, Skeleton, Odometer, ProgressRing, EmptyState |
| `src/components/feedback/ToastProvider.tsx` | HUD toasts with undo + optional sound |
| `src/components/shell/*` | nav config, Sidebar, TopBar, PageTransition, CommandPalette, AppShell |
| `src/components/auth/*`, `src/lib/auth-client.ts` | Sign-in form, OTP input, API client |
| `src/app/layout.tsx`, `src/app/(app)/…`, `src/app/sign-in/page.tsx`, `src/app/design/page.tsx`, `src/app/icon.png` | Routes |
| `infra/toolbox/Dockerfile` (repo root) | + Playwright system deps |
| `.github/workflows/ci.yml` (repo root) | + e2e job in the toolbox image |

---

### Task 1: Web test harness, Inter, tokens and base styles

**Files:**
- Create: `apps/web/vitest.config.ts`, `apps/web/vitest.setup.ts`, `apps/web/src/lib/contrast.ts`, `apps/web/src/styles/tokens.css`, `apps/web/src/styles/base.css`, `apps/web/src/styles/tokens.test.ts`, `apps/web/src/lib/contrast.test.ts`
- Create: `apps/web/public/fonts/InterVariable.woff2`, `apps/web/public/fonts/InterVariable-Italic.woff2`, `apps/web/public/fonts/LICENSE-Inter.txt`
- Modify: `apps/web/src/app/layout.tsx`

**Interfaces:**
- Produces:
  - `contrastRatio(hexA: string, hexB: string): number`, `parseHex(hex): [r,g,b]`
  - token names used by every later task: `--canvas --side-text --sheet --raised --sunk --line --line-2 --text --text-2 --text-3 --accent --accent-rgb --accent-soft --accent-ink --hover --press --danger --danger-soft --danger-ink --warn --warn-soft --warn-ink --meet --meet-soft --meet-ink --ok --ok-soft --ok-ink --cyan --wa --glass --hud --hud-text --scrim --skel --skel-hi --glow --sb --sb-hover --sb-active --shadow-sheet --shadow-pop --shadow-lift`
  - shared scales: `--font --r-sheet --r-card --r-row --r-ctl --r-chip --focus-ring`
  - base classes `.num` (tabular numbers)

- [ ] **Step 1: Test dependencies and config**

Run:
```bash
scripts/dev.sh add --filter @lume/web -D vitest@^3 @vitejs/plugin-react@^5 jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

`apps/web/vitest.config.ts`:
```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "@lume/web",
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
});
```

`apps/web/vitest.setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// jsdom lacks these; components feature-detect them.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList;
}
```

Add `"paths": { "@/*": ["./src/*"] }` inside `compilerOptions` in `apps/web/tsconfig.json`, plus `"types": ["node", "react", "react-dom", "vitest/globals", "@testing-library/jest-dom"]`.

- [ ] **Step 2: Self-host Inter 4.1**

Run (the toolbox has curl + unzip via Debian; unzip into the repo):
```bash
scripts/dev.sh run bash -c 'set -e; cd /tmp && curl -fsSL -o inter.zip https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip && python3 -c "import zipfile;z=zipfile.ZipFile(\"inter.zip\");[open(\"/repo/apps/web/public/fonts/\"+n.split(\"/\")[-1],\"wb\").write(z.read(n)) for n in z.namelist() if n.endswith((\"web/InterVariable.woff2\",\"web/InterVariable-Italic.woff2\"))];open(\"/repo/apps/web/public/fonts/LICENSE-Inter.txt\",\"wb\").write(z.read(\"LICENSE.txt\"))" && ls -l /repo/apps/web/public/fonts'
scripts/dev.sh fetch apps/web/public/fonts/InterVariable.woff2 apps/web/public/fonts/InterVariable-Italic.woff2 apps/web/public/fonts/LICENSE-Inter.txt
```
Expected: three files, the WOFF2s ≈ 340 KB and ≈ 380 KB. (`mkdir -p apps/web/public/fonts` on the PC first.)

- [ ] **Step 3: Write the failing tests**

`apps/web/src/lib/contrast.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { contrastRatio, parseHex } from "./contrast";

describe("contrast", () => {
  it("parses 3- and 6-digit hex", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("#2A5BFF")).toEqual([42, 91, 255]);
  });
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 1);
  });
});
```

`apps/web/src/styles/tokens.test.ts`:
```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../lib/contrast";

const css = readFileSync(path.join(__dirname, "tokens.css"), "utf8");

/** Custom properties declared in the first block whose selector list contains `selector`. */
function block(selector: string, within = css): Record<string, string> {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of within.matchAll(re)) {
    const sels = m[1]!.split(",").map((s) => s.trim());
    if (sels.includes(selector)) {
      return Object.fromEntries(
        [...m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1]!, d[2]!.replace(/\s+/g, " ").trim()]),
      );
    }
  }
  throw new Error(`no block for ${selector}`);
}
const media = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));

const light = block('[data-theme="porcelain"]');
const dark = block('[data-theme="obsidian"]');
const systemDark = block('[data-theme="system"]', media);

describe("theme tokens", () => {
  it("both themes define exactly the same tokens", () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  it("the system theme in dark mode is identical to Obsidian", () => {
    expect(systemDark).toEqual(dark);
  });

  it.each([
    ["porcelain", light],
    ["obsidian", dark],
  ])("%s: body text and -ink tokens reach 4.5:1 on the sheet", (_name, t) => {
    for (const k of ["--text", "--text-2", "--danger-ink", "--warn-ink", "--ok-ink", "--meet-ink", "--accent-ink"]) {
      expect(contrastRatio(t[k]!, t["--sheet"]!), k).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    ["porcelain", light],
    ["obsidian", dark],
  ])("%s: tertiary text stays legible (3:1) for captions", (_name, t) => {
    expect(contrastRatio(t["--text-3"]!, t["--sheet"]!)).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm vitest run --project @lume/web'`
Expected: FAIL, cannot resolve `./contrast` / `ENOENT tokens.css`.

- [ ] **Step 5: Implement contrast, tokens and base styles**

`apps/web/src/lib/contrast.ts`:
```ts
export function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two opaque colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
```

`apps/web/src/styles/tokens.css`:
```css
/* LUME design tokens. Spec: docs/superpowers/specs/2026-09-21-lume-frontend-design.md §3–4.
   Components use only these variables. "system" follows the OS: light = Porcelain, dark = Obsidian. */

@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("/fonts/InterVariable.woff2") format("woff2");
}
@font-face {
  font-family: "Inter";
  font-style: italic;
  font-weight: 100 900;
  font-display: swap;
  src: url("/fonts/InterVariable-Italic.woff2") format("woff2");
}

:root {
  --font: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --r-sheet: 16px;
  --r-card: 14px;
  --r-row: 12px;
  --r-ctl: 10px;
  --r-chip: 8px;
  --focus-ring: 0 0 0 4px var(--accent-soft), inset 0 0 0 1.5px var(--accent);
}

:root,
[data-theme="porcelain"],
[data-theme="system"] {
  color-scheme: light;
  --canvas: #eef0f3;
  --side-text: #3a3f4a;
  --sheet: #ffffff;
  --raised: #ffffff;
  --sunk: #f6f7f9;
  --line: rgba(12, 18, 32, 0.075);
  --line-2: rgba(12, 18, 32, 0.12);
  --text: #0a0c11;
  --text-2: #5a606d;
  --text-3: #858b97;
  --accent: #2a5bff;
  --accent-rgb: 42, 91, 255;
  --accent-soft: rgba(42, 91, 255, 0.08);
  --accent-ink: #1e47d9;
  --hover: rgba(12, 18, 32, 0.04);
  --press: rgba(12, 18, 32, 0.07);
  --danger: #e5484d;
  --danger-soft: #fdecec;
  --danger-ink: #c3272d;
  --warn: #f2a20c;
  --warn-soft: #fef4dd;
  --warn-ink: #8a5a00;
  --meet: #6e56cf;
  --meet-soft: #f0edfc;
  --meet-ink: #5539c0;
  --ok: #18a566;
  --ok-soft: #e4f6ec;
  --ok-ink: #0e7f4b;
  --cyan: #0ea5b7;
  --wa: #1faf5a;
  --glass: rgba(255, 255, 255, 0.78);
  --hud: rgba(22, 24, 30, 0.88);
  --hud-text: #f4f5f7;
  --scrim: rgba(8, 10, 14, 0.22);
  --skel: #edeff2;
  --skel-hi: #f7f8fa;
  --glow: rgba(42, 91, 255, 0.1);
  --sb: rgba(12, 18, 32, 0.16);
  --sb-hover: rgba(12, 18, 32, 0.3);
  --sb-active: rgba(12, 18, 32, 0.42);
  --shadow-sheet: 0 0 0 0.5px rgba(12, 18, 32, 0.08), 0 1px 2px rgba(12, 18, 32, 0.04), 0 12px 40px -12px rgba(12, 18, 32, 0.1);
  --shadow-pop: 0 0 0 0.5px rgba(12, 18, 32, 0.1), 0 10px 30px -6px rgba(12, 18, 32, 0.18), 0 30px 80px -20px rgba(12, 18, 32, 0.22);
  --shadow-lift: 0 0 0 0.5px rgba(12, 18, 32, 0.1), 0 12px 30px -8px rgba(12, 18, 32, 0.25);
}

[data-theme="obsidian"] {
  color-scheme: dark;
  --canvas: #060708;
  --side-text: #b4b8c0;
  --sheet: #0e0f12;
  --raised: #15171b;
  --sunk: #0a0b0d;
  --line: rgba(255, 255, 255, 0.065);
  --line-2: rgba(255, 255, 255, 0.11);
  --text: #eef0f3;
  --text-2: #9ca1ab;
  --text-3: #71767f;
  --accent: #5b84ff;
  --accent-rgb: 91, 132, 255;
  --accent-soft: rgba(91, 132, 255, 0.12);
  --accent-ink: #8aa7ff;
  --hover: rgba(255, 255, 255, 0.04);
  --press: rgba(255, 255, 255, 0.07);
  --danger: #ff5c61;
  --danger-soft: rgba(255, 92, 97, 0.12);
  --danger-ink: #ff8a8e;
  --warn: #ffb224;
  --warn-soft: rgba(255, 178, 36, 0.12);
  --warn-ink: #ffc75c;
  --meet: #9582ff;
  --meet-soft: rgba(149, 130, 255, 0.14);
  --meet-ink: #b3a6ff;
  --ok: #2fd08a;
  --ok-soft: rgba(47, 208, 138, 0.12);
  --ok-ink: #5fe0a8;
  --cyan: #22c3d6;
  --wa: #25c366;
  --glass: rgba(22, 24, 29, 0.72);
  --hud: rgba(38, 41, 48, 0.86);
  --hud-text: #f4f5f7;
  --scrim: rgba(0, 0, 0, 0.5);
  --skel: #17191d;
  --skel-hi: #1f2227;
  --glow: rgba(91, 132, 255, 0.16);
  --sb: rgba(255, 255, 255, 0.14);
  --sb-hover: rgba(255, 255, 255, 0.26);
  --sb-active: rgba(255, 255, 255, 0.38);
  --shadow-sheet: 0 0 0 0.5px rgba(255, 255, 255, 0.07), inset 0 1px 0 rgba(255, 255, 255, 0.03), 0 20px 60px -20px rgba(0, 0, 0, 0.8);
  --shadow-pop: 0 0 0 0.5px rgba(255, 255, 255, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 30px 80px -10px rgba(0, 0, 0, 0.8);
  --shadow-lift: 0 0 0 0.5px rgba(255, 255, 255, 0.14), 0 16px 40px -8px rgba(0, 0, 0, 0.8);
}

@media (prefers-color-scheme: dark) {
  [data-theme="system"] {
    color-scheme: dark;
    --canvas: #060708;
    --side-text: #b4b8c0;
    --sheet: #0e0f12;
    --raised: #15171b;
    --sunk: #0a0b0d;
    --line: rgba(255, 255, 255, 0.065);
    --line-2: rgba(255, 255, 255, 0.11);
    --text: #eef0f3;
    --text-2: #9ca1ab;
    --text-3: #71767f;
    --accent: #5b84ff;
    --accent-rgb: 91, 132, 255;
    --accent-soft: rgba(91, 132, 255, 0.12);
    --accent-ink: #8aa7ff;
    --hover: rgba(255, 255, 255, 0.04);
    --press: rgba(255, 255, 255, 0.07);
    --danger: #ff5c61;
    --danger-soft: rgba(255, 92, 97, 0.12);
    --danger-ink: #ff8a8e;
    --warn: #ffb224;
    --warn-soft: rgba(255, 178, 36, 0.12);
    --warn-ink: #ffc75c;
    --meet: #9582ff;
    --meet-soft: rgba(149, 130, 255, 0.14);
    --meet-ink: #b3a6ff;
    --ok: #2fd08a;
    --ok-soft: rgba(47, 208, 138, 0.12);
    --ok-ink: #5fe0a8;
    --cyan: #22c3d6;
    --wa: #25c366;
    --glass: rgba(22, 24, 29, 0.72);
    --hud: rgba(38, 41, 48, 0.86);
    --hud-text: #f4f5f7;
    --scrim: rgba(0, 0, 0, 0.5);
    --skel: #17191d;
    --skel-hi: #1f2227;
    --glow: rgba(91, 132, 255, 0.16);
    --sb: rgba(255, 255, 255, 0.14);
    --sb-hover: rgba(255, 255, 255, 0.26);
    --sb-active: rgba(255, 255, 255, 0.38);
    --shadow-sheet: 0 0 0 0.5px rgba(255, 255, 255, 0.07), inset 0 1px 0 rgba(255, 255, 255, 0.03), 0 20px 60px -20px rgba(0, 0, 0, 0.8);
    --shadow-pop: 0 0 0 0.5px rgba(255, 255, 255, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 30px 80px -10px rgba(0, 0, 0, 0.8);
    --shadow-lift: 0 0 0 0.5px rgba(255, 255, 255, 0.14), 0 16px 40px -8px rgba(0, 0, 0, 0.8);
  }
}
```
Note: `--text-3` and `--warn-ink` (Porcelain), and `--text-3` (Obsidian), are slightly stronger than in the prototypes so they pass the contrast test. Keep them.

`apps/web/src/styles/base.css`:
```css
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
html,
body {
  height: 100%;
}
body {
  font-family: var(--font);
  font-optical-sizing: auto;
  font-size: 0.875rem;
  line-height: 1.45;
  background: var(--canvas);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  transition: background-color 0.4s ease, color 0.4s ease;
}
button,
input,
select,
textarea {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
}
button {
  cursor: pointer;
}
a {
  color: inherit;
  text-decoration: none;
}
svg {
  display: block;
}
.num {
  font-variant-numeric: tabular-nums;
}
:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--r-ctl);
}

/* Typography roles (spec §4.1) */
.t-hero { font-size: 2.125rem; font-weight: 680; letter-spacing: -0.032em; line-height: 1.08; }
.t-page { font-size: 1.75rem; font-weight: 680; letter-spacing: -0.03em; line-height: 1.1; }
.t-section { font-size: 0.9375rem; font-weight: 650; letter-spacing: -0.015em; }
.t-meta { font-size: 0.78125rem; color: var(--text-2); }
.t-caption { font-size: 0.71875rem; font-weight: 600; color: var(--text-3); letter-spacing: 0.02em; }

/* LUME scrollbars: thin, token-coloured, visible on hover or while scrolling (spec §4.4) */
::-webkit-scrollbar { width: 11px; height: 11px; background: transparent; }
::-webkit-scrollbar-track,
::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
::-webkit-scrollbar-thumb {
  border-radius: 99px;
  border: 3px solid transparent;
  background-clip: padding-box;
  background-color: transparent;
  min-height: 40px;
}
:hover::-webkit-scrollbar-thumb,
.is-scrolling::-webkit-scrollbar-thumb { background-color: var(--sb); }
::-webkit-scrollbar-thumb:hover { background-color: var(--sb-hover); border-width: 2px; }
::-webkit-scrollbar-thumb:active { background-color: var(--sb-active); }
@supports (-moz-appearance: none) {
  * { scrollbar-width: thin; scrollbar-color: transparent transparent; }
  :hover,
  .is-scrolling { scrollbar-color: var(--sb) transparent; }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.15s !important;
    scroll-behavior: auto !important;
  }
}
@media (prefers-reduced-transparency: reduce) {
  :root { --glass: var(--raised); }
}
@media (prefers-contrast: more) {
  :root { --line: var(--line-2); }
}
```

Replace `apps/web/src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/styles/tokens.css";
import "@/styles/base.css";

export const metadata: Metadata = { title: "LUME" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="system">
      <body>{children}</body>
    </html>
  );
}
```
Remove the inline `style` props from `apps/web/src/app/page.tsx` (use `var(--canvas)` etc. in a CSS module if you keep the page; Task 7 replaces it).

- [ ] **Step 6: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm vitest run --project @lume/web && pnpm --filter @lume/web typecheck'`
Expected: contrast (2) + tokens (6) pass. If a contrast assertion fails, darken or lighten **that token** until it passes, staying as close as possible to the prototype value. Never weaken the test.

- [ ] **Step 7: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): design tokens for Porcelain/Obsidian with parity and contrast tests, self-hosted Inter

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Motion library

**Files:**
- Create: `apps/web/src/lib/motion.ts`, `apps/web/src/lib/motion.test.ts`

**Interfaces:**
- Produces:
  - `type SpringSpec = { bounce: number; response: number }`
  - `SPRINGS: { default; soft; bounce; drawer }`
  - `springAt(spec, tSeconds): number`
  - `settleTime(spec): number` (seconds)
  - `toLinearEasing(spec, samples?): string`
  - `toMotion(spec): { type: "spring"; bounce: number; visualDuration: number }`
  - `springCssVars(): Record<"--spring" | "--spring-soft" | "--spring-bounce" | "--spring-drawer", string>`
  - `project(velocityPxPerSec, decelerationRate = 0.998): number`
  - `rubberband(overshoot, dimension, constant = 0.55): number`

- [ ] **Step 1: Write the failing test**

`apps/web/src/lib/motion.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SPRINGS, project, rubberband, settleTime, springAt, springCssVars, toLinearEasing, toMotion } from "./motion";

describe("springs (Apple damping + response)", () => {
  it("start at 0 and settle at 1", () => {
    for (const s of Object.values(SPRINGS)) {
      expect(springAt(s, 0)).toBeCloseTo(0, 6);
      expect(springAt(s, settleTime(s))).toBeCloseTo(1, 2);
    }
  });

  it("critically damped springs never overshoot; bouncy ones do", () => {
    const peak = (s: (typeof SPRINGS)[keyof typeof SPRINGS]) =>
      Math.max(...Array.from({ length: 200 }, (_, i) => springAt(s, (settleTime(s) * i) / 199)));
    expect(peak(SPRINGS.default)).toBeLessThanOrEqual(1 + 1e-9);
    expect(peak(SPRINGS.soft)).toBeLessThanOrEqual(1 + 1e-9);
    expect(peak(SPRINGS.bounce)).toBeGreaterThan(1.01);
  });

  it("uses the spec's values", () => {
    expect(SPRINGS).toEqual({
      default: { bounce: 0, response: 0.38 },
      soft: { bounce: 0, response: 0.7 },
      bounce: { bounce: 0.3, response: 0.42 },
      drawer: { bounce: 0.2, response: 0.3 },
    });
  });

  it("emits a CSS linear() easing that starts at 0 and ends at 1", () => {
    const e = toLinearEasing(SPRINGS.default, 40);
    expect(e).toMatch(/^linear\(0(\.0+)?, /);
    expect(e.endsWith(", 1)")).toBe(true);
    expect(e.split(",").length).toBe(41);
  });

  it("maps to Motion's spring config", () => {
    expect(toMotion(SPRINGS.bounce)).toEqual({ type: "spring", bounce: 0.3, visualDuration: 0.42 });
  });

  it("exposes CSS variables for every spring", () => {
    expect(Object.keys(springCssVars()).sort()).toEqual(["--spring", "--spring-bounce", "--spring-drawer", "--spring-soft"]);
  });
});

describe("gesture maths", () => {
  it("projects momentum like UIScrollView (d = 0.998)", () => {
    expect(project(1000)).toBeCloseTo(499, 0);
    expect(project(-500)).toBeCloseTo(-249.5, 1);
  });

  it("rubber-bands: 0 at the edge, monotonic, never reaching the dimension", () => {
    expect(rubberband(0, 300)).toBe(0);
    expect(rubberband(50, 300)).toBeLessThan(50);
    expect(rubberband(100, 300)).toBeGreaterThan(rubberband(50, 300));
    expect(rubberband(1e6, 300)).toBeLessThan(300);
    expect(rubberband(-50, 300)).toBeCloseTo(-rubberband(50, 300), 9);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run --project @lume/web src/lib/motion.test.ts`
Expected: FAIL, cannot resolve `./motion`.

- [ ] **Step 3: Implement**

`apps/web/src/lib/motion.ts`:
```ts
/**
 * LUME motion tokens (spec §5). Apple's two designer-friendly spring parameters:
 * bounce (1 − damping ratio) and response (seconds to reach the target). Everything that moves uses these.
 */
export type SpringSpec = { bounce: number; response: number };

export const SPRINGS = {
  default: { bounce: 0, response: 0.38 },
  soft: { bounce: 0, response: 0.7 },
  bounce: { bounce: 0.3, response: 0.42 },
  drawer: { bounce: 0.2, response: 0.3 },
} as const satisfies Record<string, SpringSpec>;

/** Normalised spring position (0 → 1) at time t seconds, starting at rest. */
export function springAt({ bounce, response }: SpringSpec, t: number): number {
  const zeta = 1 - bounce;
  const w = (2 * Math.PI) / response;
  if (zeta >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
}

/** Time (s) after which the spring is visually settled; used as the CSS/WAAPI duration. */
export const settleTime = (s: SpringSpec): number => s.response * 2.2;

export function toLinearEasing(spec: SpringSpec, samples = 60): string {
  const T = settleTime(spec);
  const pts = Array.from({ length: samples + 1 }, (_, i) => (i === samples ? 1 : +springAt(spec, (T * i) / samples).toFixed(4)));
  return `linear(${pts.join(", ")})`;
}

export const toMotion = (s: SpringSpec) => ({ type: "spring" as const, bounce: s.bounce, visualDuration: s.response });

export function springCssVars() {
  return {
    "--spring": toLinearEasing(SPRINGS.default),
    "--spring-soft": toLinearEasing(SPRINGS.soft),
    "--spring-bounce": toLinearEasing(SPRINGS.bounce),
    "--spring-drawer": toLinearEasing(SPRINGS.drawer),
  };
}

/** Where a flick ends up (Apple's Designing Fluid Interfaces). Velocity in px/s → distance in px. */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Progressive resistance past a boundary; approaches but never reaches `dimension`. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  const x = Math.abs(overshoot);
  return (Math.sign(overshoot) * (x * dimension * constant)) / (dimension + constant * x);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/dev.sh run pnpm vitest run --project @lume/web src/lib/motion.test.ts`
Expected: 8 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/motion.ts apps/web/src/lib/motion.test.ts
git commit -m "feat(web): spring motion tokens, CSS linear() easings, momentum projection

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Sound library

**Files:**
- Create: `apps/web/src/lib/sound.ts`, `apps/web/src/lib/sound.test.ts`, `apps/web/src/components/feedback/SoundProvider.tsx`

**Interfaces:**
- Produces:
  - `type SoundCue = "done" | "sent" | "won" | "cleared"`
  - `SOUND_CUES: readonly SoundCue[]`
  - `CUE_NOTES: Record<SoundCue, readonly Note[]>` where `Note = { freq: number; at: number; dur: number; gain: number }`
  - `createSoundPlayer(opts: { createContext: () => AudioContextLike; isEnabled: () => boolean }): { unlock(): void; play(cue: SoundCue): void }`
  - `<SoundProvider>`
  - `useSound(): { play(cue: SoundCue): void; enabled: boolean; setEnabled(v: boolean): void }`. Persisted in `localStorage["lume.sound"]`, default on.

- [ ] **Step 1: Write the failing test**

`apps/web/src/lib/sound.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { CUE_NOTES, SOUND_CUES, createSoundPlayer, type AudioContextLike } from "./sound";

function fakeContext() {
  const started: Array<{ freq: number; at: number }> = [];
  const gains: number[] = [];
  const ctx: AudioContextLike = {
    currentTime: 10,
    state: "running",
    destination: {} as AudioDestinationNode,
    resume: async () => undefined,
    createOscillator() {
      const osc = {
        type: "sine",
        frequency: { value: 0 },
        connect: (n: unknown) => n,
        start: (at: number) => started.push({ freq: osc.frequency.value, at }),
        stop: () => undefined,
      };
      return osc as unknown as OscillatorNode;
    },
    createGain() {
      return {
        gain: {
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: (v: number) => gains.push(v),
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: (n: unknown) => n,
      } as unknown as GainNode;
    },
  };
  return { ctx, started, gains };
}

describe("sound policy", () => {
  it("only has the four achievement cues", () => {
    expect([...SOUND_CUES].sort()).toEqual(["cleared", "done", "sent", "won"]);
  });

  it("every note is soft (gain ≤ 0.03) and short (≤ 1.2 s)", () => {
    for (const cue of SOUND_CUES) for (const n of CUE_NOTES[cue]) {
      expect(n.gain).toBeLessThanOrEqual(0.03);
      expect(n.dur).toBeLessThanOrEqual(1.2);
    }
  });
});

describe("createSoundPlayer", () => {
  it("is silent until unlocked by a user gesture", () => {
    const f = fakeContext();
    const p = createSoundPlayer({ createContext: () => f.ctx, isEnabled: () => true });
    p.play("done");
    expect(f.started).toHaveLength(0);
    p.unlock();
    p.play("done");
    expect(f.started.map((s) => s.freq)).toEqual(CUE_NOTES.done.map((n) => n.freq));
    expect(f.started[0]!.at).toBeCloseTo(10 + CUE_NOTES.done[0]!.at, 6);
  });

  it("respects the user's setting", () => {
    const f = fakeContext();
    let enabled = false;
    const p = createSoundPlayer({ createContext: () => f.ctx, isEnabled: () => enabled });
    p.unlock();
    p.play("won");
    expect(f.started).toHaveLength(0);
    enabled = true;
    p.play("won");
    expect(f.started).toHaveLength(CUE_NOTES.won.length);
  });

  it("never throws if audio is unavailable", () => {
    const p = createSoundPlayer({
      createContext: () => {
        throw new Error("no audio");
      },
      isEnabled: () => true,
    });
    expect(() => (p.unlock(), p.play("sent"))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run --project @lume/web src/lib/sound.test.ts`
Expected: FAIL, cannot resolve `./sound`.

- [ ] **Step 3: Implement**

`apps/web/src/lib/sound.ts`:
```ts
/**
 * Achievement sounds (spec §6.2): synthesised, soft, short. Only these four exist on purpose.
 * Clicks, hover, navigation, toggles, panels, snooze, undo, sign-in and arrivals are silent.
 */
export type SoundCue = "done" | "sent" | "won" | "cleared";
export type Note = { freq: number; at: number; dur: number; gain: number };

export const CUE_NOTES: Record<SoundCue, readonly Note[]> = {
  done: [
    { freq: 880, at: 0, dur: 0.22, gain: 0.028 },
    { freq: 1318.5, at: 0.06, dur: 0.34, gain: 0.022 },
  ],
  sent: [
    { freq: 784, at: 0, dur: 0.2, gain: 0.024 },
    { freq: 1046.5, at: 0.06, dur: 0.24, gain: 0.022 },
    { freq: 1568, at: 0.12, dur: 0.38, gain: 0.018 },
  ],
  won: [523.3, 659.3, 784, 1046.5, 1318.5].map((freq, i) => ({ freq, at: i * 0.08, dur: 1.2 - i * 0.1, gain: 0.024 })),
  cleared: [523.3, 659.3, 784, 1046.5].map((freq, i) => ({ freq, at: i * 0.09, dur: 1.1 - i * 0.1, gain: 0.022 })),
};
export const SOUND_CUES = Object.keys(CUE_NOTES) as SoundCue[];

export type AudioContextLike = Pick<AudioContext, "currentTime" | "destination" | "createOscillator" | "createGain" | "resume" | "state">;

export function createSoundPlayer(opts: { createContext: () => AudioContextLike; isEnabled: () => boolean }) {
  let ctx: AudioContextLike | null = null;
  let unlocked = false;
  return {
    /** Call from a user gesture; browsers block audio before one. */
    unlock() {
      unlocked = true;
      try {
        ctx ??= opts.createContext();
        if (ctx.state === "suspended") void ctx.resume();
      } catch {
        ctx = null;
      }
    },
    play(cue: SoundCue) {
      if (!unlocked || !ctx || !opts.isEnabled()) return;
      try {
        const t0 = ctx.currentTime;
        for (const n of CUE_NOTES[cue]) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = n.freq;
          const t = t0 + n.at;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(n.gain, t + 0.006);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(t);
          osc.stop(t + n.dur + 0.05);
        }
      } catch {
        /* audio is decoration; never break the action */
      }
    },
  };
}
```

`apps/web/src/components/feedback/SoundProvider.tsx`:
```tsx
"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createSoundPlayer, type SoundCue } from "@/lib/sound";

type SoundApi = { play(cue: SoundCue): void; enabled: boolean; setEnabled(v: boolean): void };
const SoundContext = createContext<SoundApi>({ play: () => undefined, enabled: false, setEnabled: () => undefined });
const KEY = "lume.sound";

export function SoundProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(true);
  const enabledRef = useRef(true);
  const player = useMemo(
    () => createSoundPlayer({ createContext: () => new AudioContext(), isEnabled: () => enabledRef.current }),
    [],
  );

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved !== null) {
        enabledRef.current = saved === "on";
        setEnabledState(enabledRef.current);
      }
    } catch {
      /* private mode */
    }
    const unlock = () => player.unlock();
    window.addEventListener("pointerdown", unlock, { once: true, capture: true });
    window.addEventListener("keydown", unlock, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
    };
  }, [player]);

  const setEnabled = useCallback((v: boolean) => {
    enabledRef.current = v;
    setEnabledState(v);
    try {
      localStorage.setItem(KEY, v ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, []);

  const api = useMemo(() => ({ play: (c: SoundCue) => player.play(c), enabled, setEnabled }), [player, enabled, setEnabled]);
  return <SoundContext.Provider value={api}>{children}</SoundContext.Provider>;
}

export const useSound = () => useContext(SoundContext);
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/dev.sh run pnpm vitest run --project @lume/web src/lib/sound.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/sound.ts apps/web/src/lib/sound.test.ts apps/web/src/components/feedback/SoundProvider.tsx
git commit -m "feat(web): four soft achievement sounds, silent until a user gesture

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Core UI primitives

**Files:**
- Create in `apps/web/src/components/ui/`: `Button.tsx`, `Button.module.css`, `IconButton.tsx`, `Kbd.tsx`, `Chip.tsx`, `Chip.module.css`, `Avatar.tsx`, `Avatar.module.css`, `SegmentedControl.tsx`, `SegmentedControl.module.css`, `Switch.tsx`, `Switch.module.css`, `CheckCircle.tsx`, `CheckCircle.module.css`, `Skeleton.tsx`, `Skeleton.module.css`, `Odometer.tsx`, `Odometer.module.css`, `ProgressRing.tsx`, `EmptyState.tsx`, `EmptyState.module.css`, `ui.test.tsx`
- Create: `apps/web/src/lib/useDelayedFlag.ts`, `apps/web/src/lib/useDelayedFlag.test.ts`

**Interfaces:**
- Produces:
  - `<Button variant?: "primary"|"secondary"|"ghost"|"whatsapp"|"danger" size?: "sm"|"md" loading? …buttonProps>`
  - `<IconButton label: string …>` (label is required and becomes `aria-label`)
  - `<Kbd>`
  - `<Chip tone?: "neutral"|"accent"|"danger"|"warn"|"meet"|"ok" selected? dot?>`
  - `<Avatar name color? size?>` and `initials(name): string`
  - `<SegmentedControl<T extends string> label value options onChange size?>`
  - `<Switch checked onChange label>`
  - `<CheckCircle checked onChange label>`
  - `<Skeleton width? height? radius?>`
  - `useDelayedFlag(active: boolean, delayMs = 150): boolean`
  - `<Odometer value: number format?: (n) => string label?>`
  - `<ProgressRing value: number (0..1) size? label>`
  - `<EmptyState title body action?>`

- [ ] **Step 1: Install UI dependencies**

Run: `scripts/dev.sh add --filter @lume/web motion@^12 lucide-react radix-ui`

- [ ] **Step 2: Write the failing tests**

`apps/web/src/lib/useDelayedFlag.test.ts`:
```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "./useDelayedFlag";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useDelayedFlag", () => {
  it("stays false for fast loads and turns true only after the delay", () => {
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 150), { initialProps: { on: true } });
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(149));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
  });
});
```

`apps/web/src/components/ui/ui.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Avatar, initials } from "./Avatar";
import { Button } from "./Button";
import { CheckCircle } from "./CheckCircle";
import { IconButton } from "./IconButton";
import { Odometer } from "./Odometer";
import { ProgressRing } from "./ProgressRing";
import { SegmentedControl } from "./SegmentedControl";
import { Switch } from "./Switch";

describe("Button", () => {
  it("exposes its variant and becomes busy (and inert) while loading", async () => {
    const onClick = vi.fn();
    render(<Button variant="whatsapp" loading onClick={onClick}>Send</Button>);
    const b = screen.getByRole("button", { name: /send/i });
    expect(b).toHaveAttribute("data-variant", "whatsapp");
    expect(b).toHaveAttribute("aria-busy", "true");
    await userEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("IconButton", () => {
  it("is labelled for assistive tech", () => {
    render(<IconButton label="Notifications">🔔</IconButton>);
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
  });
});

describe("Avatar", () => {
  it("derives initials", () => {
    expect(initials("Aisha Khan")).toBe("AK");
    expect(initials("  riya  ")).toBe("RI");
    expect(initials("Mary Ann de la Cruz")).toBe("MC");
    render(<Avatar name="Tasneem" />);
    expect(screen.getByLabelText("Tasneem")).toHaveTextContent("TA");
  });
});

describe("SegmentedControl", () => {
  const opts = [
    { value: "a", label: "7D" },
    { value: "b", label: "30D" },
    { value: "c", label: "90D" },
  ] as const;

  it("is a radio group with arrow-key navigation", async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Range" value="b" options={opts} onChange={onChange} />);
    expect(screen.getByRole("radiogroup", { name: "Range" })).toBeInTheDocument();
    const b = screen.getByRole("radio", { name: "30D" });
    expect(b).toHaveAttribute("aria-checked", "true");
    b.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("c");
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("a");
  });
});

describe("Switch / CheckCircle", () => {
  it("Switch toggles with click and Space", async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Compare" />);
    const s = screen.getByRole("switch", { name: "Compare" });
    await userEvent.click(s);
    expect(onChange).toHaveBeenLastCalledWith(true);
    s.focus();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("CheckCircle reports completion once", async () => {
    const onChange = vi.fn();
    render(<CheckCircle checked={false} onChange={onChange} label="Mark done" />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Mark done" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Odometer / ProgressRing", () => {
  it("Odometer shows each digit on a strip and announces the whole value", () => {
    render(<Odometer value={42500} format={(n) => n.toLocaleString("en-US")} label="Revenue" />);
    const o = screen.getByLabelText("Revenue: 42,500");
    expect(o.querySelectorAll("[data-digit]")).toHaveLength(5);
    expect(o.querySelector('[data-digit="4"]')?.getAttribute("style")).toContain("translateY(-4em)");
  });

  it("ProgressRing clamps and reports progress", () => {
    render(<ProgressRing value={1.4} label="Cleared today" />);
    expect(screen.getByRole("progressbar", { name: "Cleared today" })).toHaveAttribute("aria-valuenow", "100");
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `scripts/dev.sh run bash -c 'pnpm install --frozen-lockfile >/dev/null && pnpm vitest run --project @lume/web src/components/ui src/lib/useDelayedFlag.test.ts'`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`apps/web/src/lib/useDelayedFlag.ts`:
```ts
"use client";
import { useEffect, useState } from "react";

/** True only once `active` has stayed true for `delayMs`. Skeletons for fast loads would just flash (spec §5.3). */
export function useDelayedFlag(active: boolean, delayMs = 150): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);
  return active && on;
}
```

`Button.module.css`:
```css
.btn {
  height: 34px;
  padding: 0 14px;
  border-radius: 9px;
  font-size: 0.8125rem;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  white-space: nowrap;
  background: var(--raised);
  box-shadow: inset 0 0 0 0.5px var(--line-2);
  transition: transform 0.1s ease-out, background-color 0.15s, filter 0.15s;
}
.btn:hover { background: var(--hover); }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.45; cursor: default; }
.sm { height: 30px; padding: 0 11px; font-size: 0.78125rem; }
.primary { background: var(--accent); color: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.15); }
.primary:hover { background: var(--accent); filter: brightness(1.06); }
.whatsapp { background: var(--wa); color: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.18); }
.whatsapp:hover { background: var(--wa); filter: brightness(1.05); }
.danger { background: var(--danger); color: #fff; box-shadow: none; }
.danger:hover { background: var(--danger); filter: brightness(1.05); }
.ghost { background: none; box-shadow: none; color: var(--text-2); }
.ghost:hover { color: var(--text); }
.spinner {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  opacity: 0.7;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.btn { position: relative; }
.hidden { opacity: 0; }
.btn .spinner { position: absolute; left: 50%; top: 50%; margin: -8px 0 0 -8px; }
```

`Button.tsx`:
```tsx
import type { ButtonHTMLAttributes } from "react";
import s from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "whatsapp" | "danger";
type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md"; loading?: boolean };

export function Button({ variant = "secondary", size = "md", loading = false, disabled, className, children, type = "button", ...rest }: Props) {
  return (
    <button
      type={type}
      data-variant={variant}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={[s.btn, variant !== "secondary" && s[variant], size === "sm" && s.sm, className].filter(Boolean).join(" ")}
      {...rest}
    >
      {/* The label stays (transparent) while loading: keeps the accessible name and the button width. */}
      <span className={loading ? s.hidden : undefined}>{children}</span>
      {loading && <span className={s.spinner} aria-hidden />}
    </button>
  );
}
```

`IconButton.tsx`:
```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";
import s from "./Button.module.css";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { label: string; children: ReactNode };

/** Icon-only button. `label` is mandatory: it's the accessible name and the tooltip. */
export function IconButton({ label, className, children, type = "button", ...rest }: Props) {
  return (
    <button type={type} aria-label={label} title={label} className={[s.btn, s.ghost, className].filter(Boolean).join(" ")} style={{ width: 34, padding: 0 }} {...rest}>
      {children}
    </button>
  );
}
```

`Kbd.tsx`:
```tsx
import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd style={{ font: "inherit", fontSize: "0.6875rem", fontWeight: 550, padding: "1px 6px", borderRadius: 5, boxShadow: "inset 0 0 0 0.5px var(--line-2)", color: "var(--text-3)" }}>
      {children}
    </kbd>
  );
}
```

`Chip.module.css`:
```css
.chip {
  height: 28px;
  padding: 0 11px;
  border-radius: var(--r-chip);
  font-size: 0.78125rem;
  font-weight: 560;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  background: var(--sheet);
  box-shadow: inset 0 0 0 0.5px var(--line-2);
  white-space: nowrap;
  transition: background-color 0.15s, color 0.15s, box-shadow 0.2s;
}
.selected { background: var(--accent-soft); color: var(--accent-ink); box-shadow: inset 0 0 0 0.5px rgba(var(--accent-rgb), 0.35); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
```

`Chip.tsx`:
```tsx
import type { ReactNode } from "react";
import s from "./Chip.module.css";

export type Tone = "neutral" | "accent" | "danger" | "warn" | "meet" | "ok";
const TONE_VAR: Record<Tone, string> = { neutral: "var(--text-3)", accent: "var(--accent)", danger: "var(--danger)", warn: "var(--warn)", meet: "var(--meet)", ok: "var(--ok)" };

export function Chip({ tone = "neutral", selected = false, dot = false, children }: { tone?: Tone; selected?: boolean; dot?: boolean; children: ReactNode }) {
  return (
    <span className={[s.chip, selected && s.selected].filter(Boolean).join(" ")} data-tone={tone}>
      {dot && <i className={s.dot} style={{ background: TONE_VAR[tone] }} />}
      {children}
    </span>
  );
}
```

`Avatar.module.css`:
```css
.avatar {
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-weight: 650;
  color: #fff;
  flex: none;
  letter-spacing: 0.02em;
}
```

`Avatar.tsx`:
```tsx
import s from "./Avatar.module.css";

const PALETTE = ["#E5484D", "#F2A20C", "#2A5BFF", "#18A566", "#6E56CF", "#0EA5B7"];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Stable colour from the name so the same person always looks the same. */
export function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function Avatar({ name, color, size = 28 }: { name: string; color?: string; size?: number }) {
  return (
    <span role="img" aria-label={name} className={s.avatar} style={{ width: size, height: size, fontSize: size * 0.39, background: color ?? avatarColor(name) }}>
      {initials(name)}
    </span>
  );
}
```

`SegmentedControl.module.css`:
```css
.group {
  display: inline-flex;
  padding: 2px;
  border-radius: 9px;
  background: var(--sunk);
  box-shadow: inset 0 0 0 0.5px var(--line);
  position: relative;
}
.item {
  position: relative;
  height: 28px;
  padding: 0 11px;
  font-size: 0.75rem;
  font-weight: 560;
  color: var(--text-2);
  border-radius: 7px;
  transition: color 0.2s;
}
.item[aria-checked="true"] { color: var(--text); }
.sm .item { height: 24px; padding: 0 9px; font-size: 0.71875rem; }
.thumb {
  position: absolute;
  inset: 0;
  border-radius: 7px;
  background: var(--raised);
  box-shadow: 0 0 0 0.5px var(--line-2), 0 1px 3px rgba(0, 0, 0, 0.08);
  z-index: 0;
}
.label { position: relative; z-index: 1; }
```

`SegmentedControl.tsx`:
```tsx
"use client";
import { motion } from "motion/react";
import { useId, useRef, type KeyboardEvent } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./SegmentedControl.module.css";

type Option<T extends string> = { readonly value: T; readonly label: string };
type Props<T extends string> = { label: string; value: T; options: readonly Option<T>[]; onChange: (v: T) => void; size?: "sm" | "md" };

/** A radio group whose selection thumb slides with a spring (shared layout, no measuring). */
export function SegmentedControl<T extends string>({ label, value, options, onChange, size = "md" }: Props<T>) {
  const layoutId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  function onKey(e: KeyboardEvent) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} className={[s.group, size === "sm" && s.sm].filter(Boolean).join(" ")} onKeyDown={onKey}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={s.item}
            onClick={() => !on && onChange(o.value)}
          >
            {on && <motion.span layoutId={layoutId} className={s.thumb} transition={toMotion(SPRINGS.default)} />}
            <span className={s.label}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
```

`Switch.module.css`:
```css
.switch { display: inline-flex; align-items: center; gap: 8px; font-size: 0.78125rem; font-weight: 560; color: var(--text-2); }
.track { width: 34px; height: 20px; border-radius: 99px; background: var(--line-2); position: relative; transition: background-color 0.25s; flex: none; }
.track::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform 0.4s var(--spring-bounce);
}
.switch[aria-checked="true"] .track { background: var(--ok); }
.switch[aria-checked="true"] .track::after { transform: translateX(14px); }
```

`Switch.tsx`:
```tsx
"use client";
import s from "./Switch.module.css";

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={s.switch} onClick={() => onChange(!checked)}>
      <span className={s.track} aria-hidden />
      {label}
    </button>
  );
}
```

`CheckCircle.module.css`:
```css
.check {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex: none;
  display: grid;
  place-items: center;
  position: relative;
  box-shadow: inset 0 0 0 1.5px var(--line-2);
  transition: box-shadow 0.2s, background-color 0.2s, transform 0.12s;
}
.check:hover { box-shadow: inset 0 0 0 1.5px var(--ok); }
.check:active { transform: scale(0.86); }
.check svg { width: 12px; height: 12px; stroke: #fff; stroke-width: 2.6; fill: none; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 20; stroke-dashoffset: 20; }
.check[aria-checked="true"] { background: var(--ok); box-shadow: none; animation: pop 0.45s var(--spring-bounce); }
.check[aria-checked="true"] svg { transition: stroke-dashoffset 0.3s 0.08s ease-out; stroke-dashoffset: 0; }
.check[aria-checked="true"]::after { content: ""; position: absolute; inset: -6px; border-radius: 50%; box-shadow: 0 0 0 2px var(--ok); animation: ripple 0.6s ease-out forwards; }
@keyframes pop { from { transform: scale(0.6); } to { transform: scale(1); } }
@keyframes ripple { from { opacity: 0.6; transform: scale(0.7); } to { opacity: 0; transform: scale(1.5); } }
```

`CheckCircle.tsx`:
```tsx
"use client";
import s from "./CheckCircle.module.css";

/** The round "mark done" control: the tick draws itself and a ring ripples out (spec §5.3). */
export function CheckCircle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} className={s.check} onClick={() => onChange(!checked)}>
      <svg viewBox="0 0 12 12" aria-hidden>
        <path d="M2.5 6.3 5 8.6l4.6-5" />
      </svg>
    </button>
  );
}
```

`Skeleton.module.css`:
```css
.sk {
  display: block;
  border-radius: 8px;
  background: linear-gradient(90deg, var(--skel) 0%, var(--skel-hi) 40%, var(--skel) 80%);
  background-size: 300% 100%;
  animation: shimmer 1.4s infinite linear;
}
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -50% 0; } }
```

`Skeleton.tsx`:
```tsx
import s from "./Skeleton.module.css";

export function Skeleton({ width = "100%", height = 14, radius }: { width?: number | string; height?: number | string; radius?: number }) {
  return <span aria-hidden className={s.sk} style={{ width, height, borderRadius: radius }} />;
}
```

`Odometer.module.css`:
```css
.odo { display: inline-flex; align-items: flex-end; font-variant-numeric: tabular-nums; }
.slot { display: inline-block; height: 1em; line-height: 1; overflow: hidden; }
.strip { display: flex; flex-direction: column; transition: transform 0.9s var(--spring-soft); }
.strip span { height: 1em; line-height: 1; }
.char { display: inline-block; height: 1em; line-height: 1; white-space: pre; }
```

`Odometer.tsx`:
```tsx
import s from "./Odometer.module.css";

const DIGITS = "0123456789";

/** Numbers that roll digit-by-digit to their new value (spec §5.3). The full value is announced once. */
export function Odometer({ value, format = String, label }: { value: number; format?: (n: number) => string; label?: string }) {
  const text = format(value);
  let digitIndex = 0;
  const digitCount = [...text].filter((c) => DIGITS.includes(c)).length;
  return (
    <span className={s.odo} aria-label={label ? `${label}: ${text}` : text} role="img">
      {[...text].map((c, i) => {
        if (!DIGITS.includes(c)) return <span key={`c${i}`} className={s.char} aria-hidden>{c}</span>;
        const delay = (digitCount - 1 - digitIndex++) * 35;
        return (
          <span key={`d${i}`} className={s.slot} aria-hidden>
            <span className={s.strip} data-digit={c} style={{ transform: `translateY(-${c}em)`, transitionDelay: `${delay}ms` }}>
              {[...DIGITS].map((d) => <span key={d}>{d}</span>)}
            </span>
          </span>
        );
      })}
    </span>
  );
}
```

`ProgressRing.tsx`:
```tsx
const C = 2 * Math.PI * 27;

export function ProgressRing({ value, size = 64, label }: { value: number; size?: number; label: string }) {
  const v = Math.min(1, Math.max(0, value));
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} style={{ transform: "rotate(-90deg)" }}>
      <circle cx="32" cy="32" r="27" fill="none" strokeWidth="6" stroke="var(--line-2)" />
      <circle cx="32" cy="32" r="27" fill="none" strokeWidth="6" stroke="var(--ok)" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - v)} style={{ transition: "stroke-dashoffset 0.9s var(--spring-soft)" }} />
    </svg>
  );
}
```

`EmptyState.module.css`:
```css
.empty { text-align: center; padding: 64px 24px; color: var(--text-2); max-width: 420px; margin: 0 auto; }
.empty img { width: 52px; height: 52px; margin: 0 auto 16px; filter: drop-shadow(0 8px 20px rgba(42, 91, 255, 0.4)); }
.empty h2 { color: var(--text); font-size: 1.0625rem; font-weight: 650; letter-spacing: -0.015em; margin-bottom: 6px; }
.empty .action { margin-top: 18px; display: flex; justify-content: center; }
```

`EmptyState.tsx`:
```tsx
import type { ReactNode } from "react";
import s from "./EmptyState.module.css";

/** Every empty state explains the next action (report §16.2). */
export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className={s.empty}>
      <img src="/lume-mark.png" alt="" />
      <h2>{title}</h2>
      <p>{body}</p>
      {action && <div className={s.action}>{action}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run --project @lume/web && pnpm --filter @lume/web typecheck'`
Expected: all web tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): core primitives: buttons, chips, avatar, segmented control, switch, tick, skeleton, odometer, ring

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Theme preference

**Files:**
- Create: `apps/web/src/lib/theme.ts`, `apps/web/src/lib/theme.test.ts`, `apps/web/src/components/theme/ThemeToggle.tsx`, `apps/web/src/components/theme/ThemeToggle.test.tsx`
- Modify: `apps/web/src/app/layout.tsx`

**Interfaces:**
- Consumes: `SegmentedControl` (Task 4), `springCssVars` (Task 2), `SoundProvider` (Task 3).
- Produces:
  - `type ThemePref = "system" | "porcelain" | "obsidian"`
  - `THEME_COOKIE = "lume_theme"`
  - `parseThemePref(v: string | undefined): ThemePref`
  - `themeCookie(pref): string` (a `Set-Cookie` style string for `document.cookie`)
  - `<ThemeToggle initial={pref} />`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/theme.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { THEME_COOKIE, parseThemePref, themeCookie } from "./theme";

describe("theme preference", () => {
  it("defaults to system and rejects unknown values", () => {
    expect(parseThemePref(undefined)).toBe("system");
    expect(parseThemePref("neon")).toBe("system");
    expect(parseThemePref("obsidian")).toBe("obsidian");
  });
  it("writes a long-lived, lax, path-wide cookie", () => {
    const c = themeCookie("porcelain");
    expect(c.startsWith(`${THEME_COOKIE}=porcelain;`)).toBe(true);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Max-Age=31536000/);
  });
});
```

`apps/web/src/components/theme/ThemeToggle.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  it("switches data-theme on <html> and remembers it in a cookie", async () => {
    document.documentElement.dataset.theme = "system";
    render(<ThemeToggle initial="system" />);
    await userEvent.click(screen.getByRole("radio", { name: "Obsidian" }));
    expect(document.documentElement.dataset.theme).toBe("obsidian");
    expect(document.cookie).toContain("lume_theme=obsidian");
    expect(screen.getByRole("radio", { name: "Obsidian" })).toHaveAttribute("aria-checked", "true");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run --project @lume/web src/lib/theme.test.ts src/components/theme`
Expected: FAIL, cannot resolve `./theme` / `./ThemeToggle`.

- [ ] **Step 3: Implement**

`apps/web/src/lib/theme.ts`:
```ts
export type ThemePref = "system" | "porcelain" | "obsidian";
export const THEME_COOKIE = "lume_theme";
const PREFS: readonly ThemePref[] = ["system", "porcelain", "obsidian"];

export function parseThemePref(v: string | undefined): ThemePref {
  return PREFS.includes(v as ThemePref) ? (v as ThemePref) : "system";
}

/** Phase 1 also stores this on the user profile; the cookie lets the server render without a flash. */
export function themeCookie(pref: ThemePref): string {
  return `${THEME_COOKIE}=${pref}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
```

`apps/web/src/components/theme/ThemeToggle.tsx`:
```tsx
"use client";
import { useState } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { themeCookie, type ThemePref } from "@/lib/theme";

const OPTIONS = [
  { value: "system", label: "Auto" },
  { value: "porcelain", label: "Porcelain" },
  { value: "obsidian", label: "Obsidian" },
] as const;

export function ThemeToggle({ initial }: { initial: ThemePref }) {
  const [pref, setPref] = useState<ThemePref>(initial);
  return (
    <SegmentedControl
      label="Theme"
      value={pref}
      options={OPTIONS}
      onChange={(v) => {
        setPref(v);
        document.documentElement.dataset.theme = v;
        document.cookie = themeCookie(v);
      }}
    />
  );
}
```

Replace `apps/web/src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { CSSProperties, ReactNode } from "react";
import { SoundProvider } from "@/components/feedback/SoundProvider";
import { ToastProvider } from "@/components/feedback/ToastProvider";
import { springCssVars } from "@/lib/motion";
import { THEME_COOKIE, parseThemePref } from "@/lib/theme";
import "@/styles/tokens.css";
import "@/styles/base.css";

export const metadata: Metadata = { title: "LUME" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = parseThemePref((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme} style={springCssVars() as CSSProperties}>
      <body>
        <SoundProvider>
          <ToastProvider>{children}</ToastProvider>
        </SoundProvider>
      </body>
    </html>
  );
}
```
In this task, render `<SoundProvider>{children}</SoundProvider>` without the `ToastProvider` import and wrapper. Task 6 adds `ToastProvider` exactly as shown above.

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run pnpm vitest run --project @lume/web src/lib/theme.test.ts src/components/theme`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/theme.ts apps/web/src/lib/theme.test.ts apps/web/src/components/theme apps/web/src/app/layout.tsx
git commit -m "feat(web): theme preference cookie, server-rendered with no flash, system via CSS

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Toasts (the HUD)

**Files:**
- Create: `apps/web/src/components/feedback/ToastProvider.tsx`, `apps/web/src/components/feedback/Toast.module.css`, `apps/web/src/components/feedback/ToastProvider.test.tsx`
- Modify: `apps/web/src/app/layout.tsx` (wrap children in `<ToastProvider>` inside `<SoundProvider>`)

**Interfaces:**
- Consumes: `useSound` (Task 3), `SPRINGS`/`toMotion` (Task 2).
- Produces:
  - `useToast(): { toast(t: ToastInput): string; dismiss(id: string): void }`
  - `ToastInput = { tone?: "ok"|"accent"|"warn"|"danger"|"wa"|"meet"; title: string; detail?: string; action?: { label: string; onClick(): void }; sound?: SoundCue; durationMs?: number }`
  - Default duration 4200 ms. At most 3 visible (oldest dropped). A toast with an `action` stays until clicked or timed out. Hover pauses the timer.

- [ ] **Step 1: Write the failing test**

`apps/web/src/components/feedback/ToastProvider.test.tsx`:
```tsx
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./ToastProvider";

// These tests cover the provider's logic (timers, cap, actions, sound), not animation. Motion's exit
// animations run on requestAnimationFrame, which fake timers don't drive in jsdom, so render plainly.
vi.mock("motion/react", async () => {
  const { createElement, forwardRef } = await import("react");
  const strip = ({ initial, animate, exit, transition, layout, ...rest }: Record<string, unknown>) => (
    void initial,
    void animate,
    void exit,
    void transition,
    void layout,
    rest
  );
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        forwardRef((p: Record<string, unknown>, ref) => createElement(tag, { ...strip(p), ref })),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: unknown }) => children,
    useReducedMotion: () => true,
  };
});

const played: string[] = [];
vi.mock("./SoundProvider", () => ({
  useSound: () => ({ play: (c: string) => played.push(c), enabled: true, setEnabled() {} }),
}));

let api: ReturnType<typeof useToast>;
function Grab() {
  api = useToast();
  return null;
}
const setup = () =>
  render(
    <ToastProvider>
      <Grab />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  played.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("toasts", () => {
  it("announces politely, plays its sound, and disappears after 4.2 s", () => {
    setup();
    act(() => void api.toast({ tone: "ok", title: "Follow-up done", detail: "Aisha Khan", sound: "done" }));
    expect(screen.getByRole("status")).toHaveTextContent("Follow-up done");
    expect(played).toEqual(["done"]);
    act(() => void vi.advanceTimersByTime(4300));
    act(() => void vi.runOnlyPendingTimers());
    expect(screen.queryByText("Follow-up done")).not.toBeInTheDocument();
  });

  it("runs the action (e.g. Undo) and closes", () => {
    setup();
    const undo = vi.fn();
    act(() => void api.toast({ title: "Moved to Won", action: { label: "Undo", onClick: undo } }));
    act(() => screen.getByRole("button", { name: "Undo" }).click());
    expect(undo).toHaveBeenCalledOnce();
    act(() => void vi.runOnlyPendingTimers());
    expect(screen.queryByText("Moved to Won")).not.toBeInTheDocument();
  });

  it("keeps at most three on screen", () => {
    setup();
    act(() => {
      for (const t of ["one", "two", "three", "four"]) api.toast({ title: t, durationMs: 60_000 });
    });
    expect(screen.queryByText("one")).not.toBeInTheDocument();
    expect(screen.getByText("four")).toBeInTheDocument();
  });

  it("is silent unless a sound is asked for", () => {
    setup();
    act(() => void api.toast({ title: "Snoozed until tomorrow" }));
    expect(played).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run --project @lume/web src/components/feedback`
Expected: FAIL, cannot resolve `./ToastProvider`.

- [ ] **Step 3: Implement**

`Toast.module.css`:
```css
.region {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  gap: 8px;
  z-index: 90;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 300px;
  max-width: min(520px, calc(100vw - 32px));
  padding: 10px 10px 10px 12px;
  border-radius: 14px;
  background: var(--hud);
  color: var(--hud-text);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 16px 40px -8px rgba(0, 0, 0, 0.4);
  position: relative;
  overflow: hidden;
}
.icon { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; flex: none; }
.icon svg { width: 14px; height: 14px; stroke: #fff; stroke-width: 2.6; fill: none; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 20; stroke-dashoffset: 20; animation: draw 0.35s 0.12s ease-out forwards; }
@keyframes draw { to { stroke-dashoffset: 0; } }
.text { flex: 1; font-size: 0.8125rem; line-height: 1.3; }
.title { font-weight: 600; display: block; }
.detail { color: rgba(244, 245, 247, 0.62); font-size: 0.75rem; }
.action { height: 30px; padding: 0 12px; border-radius: 8px; font-size: 0.78125rem; font-weight: 600; background: rgba(255, 255, 255, 0.12); color: #fff; }
.action:hover { background: rgba(255, 255, 255, 0.2); }
.timer { position: absolute; left: 0; bottom: 0; height: 2px; background: rgba(255, 255, 255, 0.35); transform-origin: left; }
```

`ToastProvider.tsx`:
```tsx
"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { SoundCue } from "@/lib/sound";
import { useSound } from "./SoundProvider";
import s from "./Toast.module.css";

type Tone = "ok" | "accent" | "warn" | "danger" | "wa" | "meet";
export type ToastInput = { tone?: Tone; title: string; detail?: string; action?: { label: string; onClick(): void }; sound?: SoundCue; durationMs?: number };
type Item = ToastInput & { id: string };
type Api = { toast(t: ToastInput): string; dismiss(id: string): void };

const ToastContext = createContext<Api>({ toast: () => "", dismiss: () => undefined });
const TONE_BG: Record<Tone, string> = { ok: "var(--ok)", accent: "var(--accent)", warn: "var(--warn)", danger: "var(--danger)", wa: "var(--wa)", meet: "var(--meet)" };
const PATH: Record<Tone, string> = {
  ok: "M3 7.5 6 10.3 11.5 4",
  wa: "M3 7.5 6 10.3 11.5 4",
  accent: "M7 3.5V7l2.5 1.5",
  meet: "M7 3.5V7l2.5 1.5",
  warn: "M7 3.5v4M7 10.2v.1",
  danger: "M4 4l6 6M10 4l-6 6",
};
const MAX = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);
  const { play } = useSound();
  const reduce = useReducedMotion();

  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const arm = useCallback((id: string, ms: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => dismiss(id), ms));
  }, [dismiss]);

  const toast = useCallback((t: ToastInput) => {
    const id = `t${++seq.current}`;
    setItems((xs) => [...xs, { ...t, id }].slice(-MAX));
    arm(id, t.durationMs ?? 4200);
    if (t.sound) play(t.sound);
    return id;
  }, [arm, play]);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={s.region} role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => {
            const tone = t.tone ?? "ok";
            const ms = t.durationMs ?? 4200;
            return (
              <motion.div
                key={t.id}
                layout
                className={s.toast}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.94, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.96, transition: { duration: 0.2, ease: "easeIn" } }}
                transition={toMotion(SPRINGS.bounce)}
                onMouseEnter={() => clearTimeout(timers.current.get(t.id))}
                onMouseLeave={() => arm(t.id, 1600)}
              >
                <span className={s.icon} style={{ background: TONE_BG[tone] }}>
                  <svg viewBox="0 0 14 14" aria-hidden><path d={PATH[tone]} /></svg>
                </span>
                <span className={s.text}>
                  <span className={s.title}>{t.title}</span>
                  {t.detail && <span className={s.detail}>{t.detail}</span>}
                </span>
                {t.action && (
                  <button type="button" className={s.action} onClick={() => { t.action!.onClick(); dismiss(t.id); }}>
                    {t.action.label}
                  </button>
                )}
                <motion.i className={s.timer} initial={{ scaleX: 1 }} animate={{ scaleX: 0 }} transition={{ duration: ms / 1000, ease: "linear" }} />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
```

Wrap `children` in `apps/web/src/app/layout.tsx` with `<ToastProvider>` inside `<SoundProvider>`, as shown in Task 4.

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run --project @lume/web && pnpm --filter @lume/web typecheck'`
Expected: 4 toast tests pass along with the rest.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): HUD toasts with undo, pause-on-hover and opt-in achievement sounds

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: App shell — navigation, sidebar, top bar, page transitions

**Files:**
- Create in `apps/web/src/components/shell/`: `nav.ts`, `nav.test.ts`, `icons.tsx`, `Sidebar.tsx`, `TopBar.tsx`, `PageTransition.tsx`, `AppShell.tsx`, `shell.module.css`, `Sidebar.test.tsx`
- Create: `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/app/(app)/today/page.tsx`, `…/leads/page.tsx`, `…/pipeline/page.tsx`, `…/calendar/page.tsx`, `…/templates/page.tsx`, `…/analytics/page.tsx`, `…/settings/page.tsx`
- Modify: `apps/web/src/app/page.tsx` (redirect to `/today`)
- Create: `apps/web/src/app/icon.png` (copy of `public/lume-mark.png`)

**Interfaces:**
- Produces:
  - `NAV_ITEMS: NavItem[]` where `NavItem = { id: string; label: string; href: string; icon: IconName; permission?: string; phase: number }`
  - `visibleNav(items, can: (perm: string) => boolean): NavItem[]`
  - `activeNav(items, pathname): NavItem | undefined`
  - `navDirection(items, fromPath, toPath): 1 | -1 | 0`
  - `<AppShell businessName user can>`
  - `usePageNav(): { go(href: string): void }` (exit animation, then `router.push`; interruptible)
  - `[data-stagger]` marks page sections that enter in order

- [ ] **Step 1: Write the failing tests**

`nav.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { NAV_ITEMS, activeNav, navDirection, visibleNav } from "./nav";

describe("navigation", () => {
  it("lists the spec's sections in order", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(["Today", "Leads", "Pipeline", "Calendar", "Templates", "Analytics", "Settings"]);
  });

  it("hides items the role cannot use (absent, not disabled)", () => {
    const can = (p: string) => ["leads.view", "calendar.view"].includes(p);
    expect(visibleNav(NAV_ITEMS, can).map((i) => i.id)).toEqual(["today", "leads", "pipeline", "calendar"]);
  });

  it("matches nested paths to their section", () => {
    expect(activeNav(NAV_ITEMS, "/leads/123")?.id).toBe("leads");
    expect(activeNav(NAV_ITEMS, "/nowhere")).toBeUndefined();
  });

  it("knows which way a navigation travels", () => {
    expect(navDirection(NAV_ITEMS, "/today", "/analytics")).toBe(1);
    expect(navDirection(NAV_ITEMS, "/analytics", "/leads")).toBe(-1);
    expect(navDirection(NAV_ITEMS, "/leads", "/leads/9")).toBe(0);
  });
});
```

`Sidebar.test.tsx`:
```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/leads", useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));

describe("Sidebar", () => {
  it("puts LUME on top and the client's name below", () => {
    render(<Sidebar businessName="Nupuur Coaching" user={{ name: "Tasneem", role: "Admin" }} can={() => true} />);
    const lockup = screen.getByTestId("lockup");
    const [brand, client] = within(lockup).getAllByText(/LUME|Nupuur Coaching/);
    expect(brand).toHaveTextContent("LUME");
    expect(client).toHaveTextContent("Nupuur Coaching");
  });

  it("marks the current section and omits sections the role can't use", () => {
    render(<Sidebar businessName="X" user={{ name: "Riya", role: "Sales" }} can={(p) => p === "leads.view"} />);
    expect(screen.getByRole("link", { name: /Leads/ })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: /Analytics/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run --project @lume/web src/components/shell`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`nav.ts`:
```ts
export type IconName = "today" | "leads" | "pipeline" | "calendar" | "templates" | "analytics" | "settings";
export type NavItem = { id: IconName; label: string; href: string; icon: IconName; permission?: string; phase: number };

/** Order matters: it drives page-transition direction (spec §5.3). `phase` = report build phase that fills it. */
export const NAV_ITEMS: NavItem[] = [
  { id: "today", label: "Today", href: "/today", icon: "today", phase: 3 },
  { id: "leads", label: "Leads", href: "/leads", icon: "leads", permission: "leads.view", phase: 1 },
  { id: "pipeline", label: "Pipeline", href: "/pipeline", icon: "pipeline", permission: "leads.view", phase: 1 },
  { id: "calendar", label: "Calendar", href: "/calendar", icon: "calendar", permission: "calendar.view", phase: 5 },
  { id: "templates", label: "Templates", href: "/templates", icon: "templates", permission: "templates.use", phase: 4 },
  { id: "analytics", label: "Analytics", href: "/analytics", icon: "analytics", permission: "analytics.view", phase: 7 },
  { id: "settings", label: "Settings", href: "/settings", icon: "settings", permission: "settings.manage", phase: 1 },
];

export const visibleNav = (items: NavItem[], can: (p: string) => boolean) => items.filter((i) => !i.permission || can(i.permission));

export const activeNav = (items: NavItem[], pathname: string) =>
  items.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));

export function navDirection(items: NavItem[], from: string, to: string): 1 | -1 | 0 {
  const a = items.indexOf(activeNav(items, from)!);
  const b = items.indexOf(activeNav(items, to)!);
  if (a < 0 || b < 0 || a === b) return 0;
  return b > a ? 1 : -1;
}
```

`icons.tsx`:
```tsx
import { BarChart3, CalendarDays, Columns3, Mail, Settings, Sun, Users } from "lucide-react";
import type { IconName } from "./nav";

const MAP = { today: Sun, leads: Users, pipeline: Columns3, calendar: CalendarDays, templates: Mail, analytics: BarChart3, settings: Settings };

export function NavIcon({ name }: { name: IconName }) {
  const I = MAP[name];
  return <I size={17} strokeWidth={1.8} aria-hidden />;
}
```

`shell.module.css`:
```css
.app { display: grid; grid-template-columns: 244px minmax(0, 1fr); height: 100vh; }
.side { padding: 14px 10px; display: flex; flex-direction: column; gap: 2px; color: var(--side-text); min-height: 0; }
.lockup { display: flex; align-items: center; gap: 11px; padding: 8px 10px 18px; }
.lockup img { width: 28px; height: 28px; filter: drop-shadow(0 2px 6px rgba(42, 91, 255, 0.35)); }
.brand { font-weight: 760; font-size: 0.9375rem; color: var(--text); letter-spacing: 0.06em; line-height: 1.1; display: block; }
.client { font-size: 0.71875rem; color: var(--text-3); display: block; margin-top: 1px; }
.nav { position: relative; display: flex; flex-direction: column; gap: 2px; }
.link { position: relative; display: flex; align-items: center; gap: 11px; height: 34px; padding: 0 10px; border-radius: 9px; font-size: 0.84375rem; font-weight: 500; transition: color 0.2s; }
.link:not([aria-current="page"]):hover { background: var(--hover); }
.link:active { transform: scale(0.985); }
.link svg { opacity: 0.75; position: relative; z-index: 1; }
.link span { position: relative; z-index: 1; }
.link[aria-current="page"] { color: var(--text); }
.link[aria-current="page"] svg { opacity: 1; color: var(--accent); }
.pill { position: absolute; inset: 0; border-radius: 9px; background: var(--sheet); box-shadow: 0 0 0 0.5px var(--line-2), 0 1px 2px rgba(0, 0, 0, 0.05); z-index: 0; }
.spacer { flex: 1; }
.me { display: flex; align-items: center; gap: 10px; padding: 8px 10px; }
.meName { font-size: 0.8125rem; font-weight: 580; color: var(--text); display: block; }
.meRole { font-size: 0.71875rem; color: var(--text-3); display: block; }
.main { margin: 8px 8px 8px 0; background: var(--sheet); border-radius: var(--r-sheet); box-shadow: var(--shadow-sheet); display: flex; flex-direction: column; overflow: hidden; min-width: 0; transition: background-color 0.4s; }
.bar { height: 56px; display: flex; align-items: center; gap: 12px; padding: 0 20px 0 28px; border-bottom: 0.5px solid var(--line); flex: none; }
.crumb { font-weight: 600; font-size: 0.875rem; letter-spacing: -0.01em; }
.search { margin-left: auto; display: flex; align-items: center; gap: 8px; height: 34px; width: 300px; padding: 0 10px 0 12px; border-radius: var(--r-ctl); background: var(--sunk); box-shadow: inset 0 0 0 0.5px var(--line); color: var(--text-3); font-size: 0.8125rem; }
.search:hover { box-shadow: inset 0 0 0 0.5px var(--line-2); }
.search kbd { margin-left: auto; }
.scroll { flex: 1; overflow-y: auto; overflow-x: hidden; position: relative; }
.page { max-width: 1160px; margin: 0 auto; padding: 34px 36px 110px; min-width: 0; }
@media (max-width: 860px) {
  .app { grid-template-columns: 1fr; }
  .side { display: none; }
  .main { margin: 0; border-radius: 0; }
  .search { width: auto; }
  .page { padding: 22px 16px 96px; }
}
```

`Sidebar.tsx`:
```tsx
"use client";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar } from "@/components/ui/Avatar";
import { SPRINGS, toMotion } from "@/lib/motion";
import { NavIcon } from "./icons";
import { NAV_ITEMS, activeNav, visibleNav } from "./nav";
import { usePageNav } from "./PageTransition";
import s from "./shell.module.css";

type Props = { businessName: string; user: { name: string; role: string }; can: (p: string) => boolean };

export function Sidebar({ businessName, user, can }: Props) {
  const pathname = usePathname();
  const items = visibleNav(NAV_ITEMS, can);
  const current = activeNav(items, pathname);
  const { go } = usePageNav();
  const reduce = useReducedMotion();
  return (
    <aside className={s.side}>
      <div className={s.lockup} data-testid="lockup">
        <img src="/lume-mark.png" alt="" />
        <div>
          <span className={s.brand}>LUME</span>
          <span className={s.client}>{businessName}</span>
        </div>
      </div>
      <nav className={s.nav} aria-label="Main">
        {items.map((i) => {
          const on = i.id === current?.id;
          return (
            <Link
              key={i.id}
              href={i.href}
              className={s.link}
              aria-current={on ? "page" : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                go(i.href);
              }}
            >
              {on && (
                // One shared pill travels between items; it stretches slightly along the way (spec §5.3).
                <motion.span
                  layoutId="nav-pill"
                  className={s.pill}
                  transition={reduce ? { duration: 0 } : { layout: toMotion(SPRINGS.default) }}
                />
              )}
              <NavIcon name={i.icon} />
              <span>{i.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className={s.spacer} />
      <div className={s.me}>
        <Avatar name={user.name} color="linear-gradient(135deg,#2A5BFF,#16B5FF)" />
        <div>
          <span className={s.meName}>{user.name}</span>
          <span className={s.meRole}>{user.role}</span>
        </div>
      </div>
    </aside>
  );
}
```

`PageTransition.tsx`:
```tsx
"use client";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { SPRINGS, settleTime, toLinearEasing } from "@/lib/motion";
import { NAV_ITEMS, navDirection } from "./nav";

type Api = { go(href: string): void };
const NavCtx = createContext<Api>({ go: () => undefined });
const RefCtx = createContext<RefObject<HTMLDivElement | null> | null>(null);
export const usePageNav = () => useContext(NavCtx);

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Page switching (spec §5.3): the old page recedes for 140 ms against the travel direction, then the new
 * page's [data-stagger] sections arrive in reading order along it. A newer navigation interrupts instantly.
 * Only <PageContent> animates; the sidebar and top bar stay put.
 */
export function PageTransitionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const container = useRef<HTMLDivElement>(null);
  const prev = useRef(pathname);
  const pending = useRef<Animation | null>(null);

  const go = useCallback(
    (href: string) => {
      if (href === pathname) return;
      pending.current?.cancel();
      const el = container.current;
      if (!el || reduced() || typeof el.animate !== "function") return router.push(href);
      const dir = navDirection(NAV_ITEMS, pathname, href) || 1;
      const a = el.animate(
        [
          { opacity: 1, transform: "none", filter: "blur(0)" },
          { opacity: 0, transform: `translateY(${-8 * dir}px) scale(0.992)`, filter: "blur(2px)" },
        ],
        { duration: 140, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" },
      );
      pending.current = a;
      a.finished.then(() => pending.current === a && router.push(href)).catch(() => undefined);
    },
    [pathname, router],
  );

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    el.getAnimations().forEach((a) => a.cancel());
    pending.current = null;
    const dir = navDirection(NAV_ITEMS, prev.current, pathname) || 1;
    prev.current = pathname;
    if (reduced() || typeof el.animate !== "function") return;
    const ease = toLinearEasing(SPRINGS.soft);
    el.querySelectorAll<HTMLElement>("[data-stagger]").forEach((node, i) =>
      node.animate([{ opacity: 0, transform: `translateY(${16 * dir}px)` }, { opacity: 1, transform: "none" }], {
        duration: settleTime(SPRINGS.soft) * 1000,
        easing: ease,
        delay: i * 38,
        fill: "backwards",
      }),
    );
  }, [pathname]);

  useEffect(() => {
    container.current?.closest("[data-scroll]")?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <NavCtx.Provider value={{ go }}>
      <RefCtx.Provider value={container}>{children}</RefCtx.Provider>
    </NavCtx.Provider>
  );
}

/** Wraps the routed page; this is the element that recedes and whose sections stagger in. */
export function PageContent({ children }: { children: ReactNode }) {
  const ref = useContext(RefCtx);
  return <div ref={ref ?? undefined}>{children}</div>;
}
```

`TopBar.tsx`:
```tsx
"use client";
import { Bell, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import type { ThemePref } from "@/lib/theme";
import { NAV_ITEMS, activeNav } from "./nav";
import s from "./shell.module.css";

export function TopBar({ theme, onSearch }: { theme: ThemePref; onSearch(): void }) {
  const title = activeNav(NAV_ITEMS, usePathname())?.label ?? "LUME";
  return (
    <header className={s.bar}>
      <h1 className={s.crumb}>{title}</h1>
      <button type="button" className={s.search} onClick={onSearch}>
        <Search size={15} aria-hidden />
        Search leads, actions…
        <Kbd>Ctrl K</Kbd>
      </button>
      <ThemeToggle initial={theme} />
      <IconButton label="Notifications">
        <Bell size={18} strokeWidth={1.8} aria-hidden />
      </IconButton>
    </header>
  );
}
```

`AppShell.tsx`:
```tsx
"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { ThemePref } from "@/lib/theme";
import { CommandPalette } from "./CommandPalette";
import { PageContent, PageTransitionProvider } from "./PageTransition";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import s from "./shell.module.css";

type Props = { businessName: string; user: { name: string; role: string }; permissions: string[]; theme: ThemePref; children: ReactNode };

export function AppShell({ businessName, user, permissions, theme, children }: Props) {
  const [palette, setPalette] = useState(false);
  const can = (p: string) => permissions.includes(p);

  useEffect(() => {
    // Scrollbars fade in while scrolling (spec §4.4).
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
    const onScroll = (e: Event) => {
      const el = e.target instanceof Element ? e.target : document.documentElement;
      el.classList.add("is-scrolling");
      clearTimeout(timers.get(el));
      timers.set(el, setTimeout(() => el.classList.remove("is-scrolling"), 900));
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <PageTransitionProvider>
      <div className={s.app}>
        <Sidebar businessName={businessName} user={user} can={can} />
        <main className={s.main}>
          <TopBar theme={theme} onSearch={() => setPalette(true)} />
          <div className={s.scroll} data-scroll>
            <div className={s.page}>
              <PageContent>{children}</PageContent>
            </div>
          </div>
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} can={can} />
    </PageTransitionProvider>
  );
}
```
`apps/web/src/app/(app)/layout.tsx`:
```tsx
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { THEME_COOKIE, parseThemePref } from "@/lib/theme";

// Phase 1 replaces these with the signed-in user's session, settings.business_name and effective permissions.
const DEV_PERMISSIONS = ["leads.view", "calendar.view", "templates.use", "analytics.view", "settings.manage"];

export default async function AppLayout({ children }: { children: ReactNode }) {
  const theme = parseThemePref((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <AppShell businessName="Nupuur Coaching" user={{ name: "Tasneem", role: "Admin" }} permissions={DEV_PERMISSIONS} theme={theme}>
      {children}
    </AppShell>
  );
}
```

Each section page, e.g. `apps/web/src/app/(app)/leads/page.tsx` (repeat per section with its own title, body and phase):
```tsx
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata = { title: "Leads · LUME" };

export default function Page() {
  return (
    <section data-stagger>
      <EmptyState title="Leads arrive in Phase 1" body="This is where every lead you can see will live: table and board, filters, saved views and bulk actions." />
    </section>
  );
}
```
Titles and bodies:

| Page | Title | Body |
|---|---|---|
| today | Your day starts here | Follow-ups, calls and new leads that need you will appear here in Phase 3. |
| leads | Leads arrive in Phase 1 | as above |
| pipeline | Your pipeline | Drag leads between your own stages. Arrives with leads in Phase 1. |
| calendar | Lead meetings only | Calls with leads (never your personal events) arrive in Phase 5. |
| templates | WhatsApp templates | Write once, send in one click. Arrives in Phase 4. |
| analytics | Numbers that answer questions | Funnel, team and revenue analytics arrive in Phase 7. |
| settings | Make LUME yours | Pipelines, fields, roles and access arrive in Phase 1. |

`apps/web/src/app/page.tsx`:
```tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/today");
}
```
Run: `cp public/lume-mark.png apps/web/src/app/icon.png`

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run --project @lume/web && pnpm --filter @lume/web typecheck && cd apps/web && pnpm build >/dev/null && echo BUILD_OK'`
Expected: nav (4) + Sidebar (2) pass with the rest; `BUILD_OK`.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): app shell with sliding nav pill, direction-aware page transitions, permission-filtered nav

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Command palette (Ctrl/Cmd+K)

**Files:**
- Create: `apps/web/src/components/shell/CommandPalette.tsx`, `apps/web/src/components/shell/palette.module.css`, `apps/web/src/components/shell/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: `NAV_ITEMS`, `visibleNav`, `usePageNav`.
- Produces: `<CommandPalette open onOpenChange can />`. It matches "Go to …" commands by case-insensitive substring; ↑/↓ select, Enter runs, Esc closes. Lead search joins in Phase 1.

- [ ] **Step 1: Write the failing test**

`CommandPalette.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

const go = vi.fn();
vi.mock("./PageTransition", () => ({ usePageNav: () => ({ go }) }));

describe("CommandPalette", () => {
  it("filters commands and runs the selected one with Enter", async () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} can={() => true} />);
    const input = screen.getByRole("combobox", { name: /search/i });
    await userEvent.type(input, "anal");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(go).toHaveBeenCalledWith("/analytics");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("never offers sections the role can't open", () => {
    render(<CommandPalette open onOpenChange={() => undefined} can={(p) => p === "leads.view"} />);
    expect(screen.queryByRole("option", { name: /Analytics/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Leads/ })).toBeInTheDocument();
  });

  it("moves the selection with the arrow keys", async () => {
    render(<CommandPalette open onOpenChange={() => undefined} can={() => true} />);
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `scripts/dev.sh run pnpm vitest run --project @lume/web src/components/shell/CommandPalette.test.tsx`
Expected: FAIL, cannot resolve `./CommandPalette`.

- [ ] **Step 3: Implement**

`palette.module.css`:
```css
.overlay { position: fixed; inset: 0; background: var(--scrim); z-index: 60; }
.panel {
  position: fixed;
  left: 50%;
  top: 14vh;
  width: min(620px, calc(100vw - 32px));
  transform: translateX(-50%);
  border-radius: 18px;
  background: var(--raised);
  box-shadow: var(--shadow-pop);
  z-index: 61;
  overflow: hidden;
}
.input { width: 100%; height: 58px; border: 0; outline: 0; padding: 0 20px; font-size: 1.0625rem; letter-spacing: -0.01em; border-bottom: 0.5px solid var(--line); background: transparent; }
.input::placeholder { color: var(--text-3); }
.list { padding: 8px; max-height: 50vh; overflow: auto; }
.group { font-size: 0.71875rem; font-weight: 600; color: var(--text-3); padding: 8px 12px 4px; }
.option { display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 12px; border-radius: 10px; font-size: 0.84375rem; cursor: pointer; }
.option[aria-selected="true"] { background: var(--accent-soft); }
.empty { padding: 18px 12px; color: var(--text-3); font-size: 0.8125rem; }
.foot { display: flex; gap: 16px; padding: 10px 20px; border-top: 0.5px solid var(--line); font-size: 0.71875rem; color: var(--text-3); }
```

`CommandPalette.tsx`:
```tsx
"use client";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import { NavIcon } from "./icons";
import { NAV_ITEMS, visibleNav } from "./nav";
import { usePageNav } from "./PageTransition";
import s from "./palette.module.css";

type Props = { open: boolean; onOpenChange(v: boolean): void; can(p: string): boolean };

export function CommandPalette({ open, onOpenChange, can }: Props) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const { go } = usePageNav();
  const listId = useId();
  const commands = useMemo(() => visibleNav(NAV_ITEMS, can).map((i) => ({ id: i.id, label: `Go to ${i.label}`, href: i.href, icon: i.icon })), [can]);
  const matches = commands.filter((c) => c.label.toLowerCase().includes(query.trim().toLowerCase()));

  function run(i: number) {
    const c = matches[i];
    if (!c) return;
    onOpenChange(false);
    setQuery("");
    setSel(0);
    go(c.href);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = matches.length || 1;
      setSel((v) => (v + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(sel);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div className={s.overlay} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined} onKeyDown={onKey}>
              <motion.div
                className={s.panel}
                initial={{ opacity: 0, scale: 0.96, y: -6, filter: "blur(6px)", x: "-50%" }}
                animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)", x: "-50%" }}
                exit={{ opacity: 0, scale: 0.97, y: -4, x: "-50%", transition: { duration: 0.15 } }}
                transition={toMotion(SPRINGS.default)}
              >
                <Dialog.Title style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Command palette</Dialog.Title>
                <input
                  className={s.input}
                  role="combobox"
                  aria-label="Search leads or type a command"
                  aria-expanded
                  aria-controls={listId}
                  aria-activedescendant={matches[sel] ? `${listId}-${matches[sel]!.id}` : undefined}
                  placeholder="Search leads, or type a command…"
                  value={query}
                  autoFocus
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSel(0);
                  }}
                />
                <div className={s.list} role="listbox" id={listId}>
                  <div className={s.group}>Go to</div>
                  {matches.length === 0 && <div className={s.empty}>No matches. Lead search arrives in Phase 1.</div>}
                  {matches.map((c, i) => (
                    <div key={c.id} id={`${listId}-${c.id}`} role="option" aria-selected={i === sel} className={s.option} onMouseEnter={() => setSel(i)} onClick={() => run(i)}>
                      <NavIcon name={c.icon} />
                      {c.label}
                    </div>
                  ))}
                </div>
                <div className={s.foot}>
                  <span>↑↓ navigate</span>
                  <span>↵ open</span>
                  <span>esc close</span>
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run --project @lume/web && pnpm --filter @lume/web typecheck'`
Expected: 3 palette tests pass with the rest.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): Ctrl/Cmd+K command palette with keyboard navigation and permission-aware commands

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Sign-in with two-step code

**Files:**
- Create: `apps/web/src/lib/auth-client.ts`, `apps/web/src/lib/auth-client.test.ts`, `apps/web/src/components/auth/OtpInput.tsx`, `apps/web/src/components/auth/OtpInput.test.tsx`, `apps/web/src/components/auth/SignInForm.tsx`, `apps/web/src/components/auth/SignInForm.test.tsx`, `apps/web/src/components/auth/auth.module.css`, `apps/web/src/app/sign-in/page.tsx`

**Interfaces:**
- Produces:
  - `signIn(email, password): Promise<SignInResult>` where `SignInResult = { status: "ok" } | { status: "otp_required" } | { status: "invalid" } | { status: "locked" } | { status: "unavailable" }`. It calls `POST /api/v1/auth/login`; Phase 1 implements the endpoint.
  - `verifyOtp(code): Promise<"ok" | "invalid" | "unavailable">`, which calls `POST /api/v1/auth/2fa`
  - `<OtpInput length=6 onComplete(code) disabled?>`
  - `<SignInForm businessName onSignIn onVerify onSuccess>`

- [ ] **Step 1: Write the failing tests**

`auth-client.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { signIn, verifyOtp } from "./auth-client";

const respond = (status: number, body: unknown = {}) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
afterEach(() => vi.restoreAllMocks());

describe("signIn", () => {
  it("posts JSON same-origin and maps outcomes", async () => {
    const f = respond(200, { next: "otp" });
    expect(await signIn("t@x.com", "pw")).toEqual({ status: "otp_required" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/v1/auth/login");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(init?.body))).toEqual({ email: "t@x.com", password: "pw" });

    respond(200, { next: "done" });
    expect(await signIn("t@x.com", "pw")).toEqual({ status: "ok" });
    respond(401, { error: { code: "INVALID_CREDENTIALS" } });
    expect(await signIn("t@x.com", "pw")).toEqual({ status: "invalid" });
    respond(423, { error: { code: "ACCOUNT_LOCKED" } });
    expect(await signIn("t@x.com", "pw")).toEqual({ status: "locked" });
    respond(404);
    expect(await signIn("t@x.com", "pw")).toEqual({ status: "unavailable" });
  });

  it("treats network failures as unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    expect(await signIn("a@b.c", "x")).toEqual({ status: "unavailable" });
  });
});

describe("verifyOtp", () => {
  it("maps outcomes", async () => {
    respond(200);
    expect(await verifyOtp("123456")).toBe("ok");
    respond(401);
    expect(await verifyOtp("000000")).toBe("invalid");
    respond(502);
    expect(await verifyOtp("123456")).toBe("unavailable");
  });
});
```

`OtpInput.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OtpInput } from "./OtpInput";

const boxes = () => screen.getAllByRole("textbox");

describe("OtpInput", () => {
  it("advances as digits are typed and completes once", async () => {
    const onComplete = vi.fn();
    render(<OtpInput onComplete={onComplete} />);
    boxes()[0]!.focus();
    await userEvent.keyboard("12a3456");
    expect(boxes().map((b) => (b as HTMLInputElement).value).join("")).toBe("123456");
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith("123456");
  });

  it("goes back on Backspace from an empty box", async () => {
    render(<OtpInput onComplete={() => undefined} />);
    boxes()[0]!.focus();
    await userEvent.keyboard("12{Backspace}{Backspace}");
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it("accepts a pasted code", () => {
    const onComplete = vi.fn();
    render(<OtpInput onComplete={onComplete} />);
    fireEvent.paste(boxes()[0]!, { clipboardData: { getData: () => " 654 321 " } });
    expect(onComplete).toHaveBeenCalledWith("654321");
  });

  it("labels every box", () => {
    render(<OtpInput onComplete={() => undefined} />);
    expect(screen.getByLabelText("Digit 1 of 6")).toBeInTheDocument();
  });
});
```

`SignInForm.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SignInForm } from "./SignInForm";

const fill = async () => {
  await userEvent.type(screen.getByLabelText("Email"), "t@nupuur.com");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
};

describe("SignInForm", () => {
  it("shows the brand: LUME above the client name", () => {
    render(<SignInForm businessName="Nupuur Coaching" onSignIn={vi.fn()} onVerify={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "LUME" })).toBeInTheDocument();
    expect(screen.getByText("Nupuur Coaching")).toBeInTheDocument();
  });

  it("gives one generic message for bad credentials (no user enumeration)", async () => {
    render(<SignInForm businessName="X" onSignIn={async () => ({ status: "invalid" })} onVerify={vi.fn()} onSuccess={vi.fn()} />);
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("That email and password don’t match.");
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
  });

  it("moves to the two-step code and finishes", async () => {
    const onSuccess = vi.fn();
    render(<SignInForm businessName="X" onSignIn={async () => ({ status: "otp_required" })} onVerify={async () => "ok"} onSuccess={onSuccess} />);
    await fill();
    const first = await screen.findByLabelText("Digit 1 of 6");
    first.focus();
    await userEvent.keyboard("123456");
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it("explains when the server can't be reached", async () => {
    render(<SignInForm businessName="X" onSignIn={async () => ({ status: "unavailable" })} onVerify={vi.fn()} onSuccess={vi.fn()} />);
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("can’t reach the server");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `scripts/dev.sh run pnpm vitest run --project @lume/web src/lib/auth-client.test.ts src/components/auth`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`auth-client.ts`:
```ts
export type SignInResult = { status: "ok" } | { status: "otp_required" } | { status: "invalid" } | { status: "locked" } | { status: "unavailable" };

async function post(url: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return null;
  }
}

/** Phase 1 implements POST /api/v1/auth/login → { next: "otp" | "done" } (report §12.1). */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const res = await post("/api/v1/auth/login", { email, password });
  if (!res) return { status: "unavailable" };
  if (res.status === 401) return { status: "invalid" };
  if (res.status === 423 || res.status === 429) return { status: "locked" };
  if (!res.ok) return { status: "unavailable" };
  const data = (await res.json().catch(() => ({}))) as { next?: string };
  return data.next === "otp" ? { status: "otp_required" } : { status: "ok" };
}

export async function verifyOtp(code: string): Promise<"ok" | "invalid" | "unavailable"> {
  const res = await post("/api/v1/auth/2fa", { code });
  if (!res) return "unavailable";
  if (res.status === 401 || res.status === 400) return "invalid";
  return res.ok ? "ok" : "unavailable";
}
```

`auth.module.css`:
```css
.page { position: fixed; inset: 0; display: grid; place-items: center; overflow: hidden; background: var(--canvas); }
.aura { position: absolute; inset: -20%; pointer-events: none; }
.aura i { position: absolute; border-radius: 50%; filter: blur(70px); }
.aura i:nth-child(1) { left: 22%; top: 18%; width: 46vw; height: 46vw; background: rgba(var(--accent-rgb), 0.16); }
.aura i:nth-child(2) { left: 48%; top: 36%; width: 34vw; height: 34vw; background: rgba(22, 181, 255, 0.14); }
.wrap { position: relative; width: min(380px, calc(100vw - 32px)); text-align: center; }
.mark { width: 76px; height: 76px; margin: 0 auto; filter: drop-shadow(0 12px 30px rgba(42, 91, 255, 0.45)); }
.brand { margin-top: 20px; }
.brand h1 { font-size: 1.875rem; font-weight: 780; letter-spacing: 0.14em; padding-left: 0.14em; line-height: 1; }
.brand p { color: var(--text-2); font-size: 0.875rem; margin-top: 8px; }
.card { margin-top: 30px; padding: 24px; border-radius: 20px; background: var(--glass); backdrop-filter: blur(30px) saturate(180%); -webkit-backdrop-filter: blur(30px) saturate(180%); box-shadow: var(--shadow-pop); text-align: left; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.input { width: 100%; height: 44px; border-radius: 11px; padding: 0 14px; background: var(--sheet); box-shadow: inset 0 0 0 0.5px var(--line-2); outline: 0; font-size: 0.90625rem; transition: box-shadow 0.2s; }
.input:focus { box-shadow: inset 0 0 0 1.5px var(--accent), 0 0 0 4px var(--accent-soft); }
.input[aria-invalid="true"] { box-shadow: inset 0 0 0 1.5px var(--danger), 0 0 0 4px var(--danger-soft); }
.error { font-size: 0.78125rem; color: var(--danger-ink); padding: 2px 0 8px; }
.submit { width: 100%; height: 46px; margin-top: 4px; }
.fine { font-size: 0.75rem; color: var(--text-3); margin-top: 16px; display: flex; justify-content: space-between; gap: 12px; }
.fine a { color: var(--accent-ink); font-weight: 560; }
.otpTitle { font-weight: 650; font-size: 0.96875rem; text-align: center; }
.otpSub { font-size: 0.8125rem; color: var(--text-2); text-align: center; margin: 4px 0 14px; }
.otp { display: flex; gap: 8px; justify-content: center; }
.otp input { width: 46px; height: 54px; border-radius: 12px; text-align: center; font-size: 1.375rem; font-weight: 650; font-variant-numeric: tabular-nums; background: var(--sheet); box-shadow: inset 0 0 0 0.5px var(--line-2); outline: 0; transition: box-shadow 0.2s; }
.otp input:focus { box-shadow: inset 0 0 0 1.5px var(--accent), 0 0 0 4px var(--accent-soft); }
@keyframes shake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-8px); } 40% { transform: translateX(7px); } 60% { transform: translateX(-4px); } 80% { transform: translateX(2px); } }
.shake { animation: shake 0.42s ease; }
```

`OtpInput.tsx`:
```tsx
"use client";
import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import s from "./auth.module.css";

export function OtpInput({ length = 6, onComplete, disabled = false }: { length?: number; onComplete(code: string): void; disabled?: boolean }) {
  const [digits, setDigits] = useState<string[]>(() => Array(length).fill(""));
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const done = useRef(false);

  function commit(next: string[]) {
    setDigits(next);
    if (next.every(Boolean) && !done.current) {
      done.current = true;
      onComplete(next.join(""));
    }
    if (!next.every(Boolean)) done.current = false;
  }

  function onKeyDown(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      e.preventDefault();
      const next = [...digits];
      if (next[i]) next[i] = "";
      else if (i > 0) {
        next[i - 1] = "";
        refs.current[i - 1]?.focus();
      }
      commit(next);
      return;
    }
    if (!/^\d$/.test(e.key)) return;
    e.preventDefault();
    const next = [...digits];
    next[i] = e.key;
    commit(next);
    refs.current[Math.min(i + 1, length - 1)]?.focus();
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const code = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (code.length !== length) return;
    e.preventDefault();
    commit(code.split(""));
    refs.current[length - 1]?.focus();
  }

  return (
    <div className={s.otp} role="group" aria-label="Two-step code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1} of ${length}`}
          maxLength={1}
          disabled={disabled}
          onChange={() => undefined}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
        />
      ))}
    </div>
  );
}
```

`SignInForm.tsx`:
```tsx
"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import type { SignInResult } from "@/lib/auth-client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { OtpInput } from "./OtpInput";
import s from "./auth.module.css";

type Props = {
  businessName: string;
  onSignIn(email: string, password: string): Promise<SignInResult>;
  onVerify(code: string): Promise<"ok" | "invalid" | "unavailable">;
  onSuccess(): void;
};

const MESSAGES = {
  invalid: "That email and password don’t match. Try again.",
  locked: "Too many attempts. Wait a few minutes, then try again.",
  unavailable: "LUME can’t reach the server right now. Try again in a moment.",
  otp: "That code didn’t work. Check your authenticator app and try again.",
} as const;

export function SignInForm({ businessName, onSignIn, onVerify, onSuccess }: Props) {
  const [step, setStep] = useState<"password" | "otp">("password");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otpKey, setOtpKey] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  const shake = () => {
    const el = card.current;
    if (!el || reduce) return;
    el.classList.remove(s.shake!);
    void el.offsetWidth;
    el.classList.add(s.shake!);
  };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const r = await onSignIn(String(f.get("email") ?? ""), String(f.get("password") ?? ""));
    setBusy(false);
    if (r.status === "ok") return onSuccess();
    if (r.status === "otp_required") return setStep("otp");
    setError(MESSAGES[r.status]);
    shake();
  }

  async function verify(code: string) {
    setBusy(true);
    setError(null);
    const r = await onVerify(code);
    setBusy(false);
    if (r === "ok") return onSuccess();
    setError(r === "invalid" ? MESSAGES.otp : MESSAGES.unavailable);
    setOtpKey((k) => k + 1);
    shake();
  }

  const bloom = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, scale: 0.35, rotate: -120, filter: "blur(8px)" }, animate: { opacity: 1, scale: 1, rotate: 0, filter: "blur(0px)" } };

  return (
    <div className={s.wrap}>
      <motion.img src="/lume-mark.png" alt="" className={s.mark} {...bloom} transition={{ ...toMotion(SPRINGS.bounce), visualDuration: 1.1 }} />
      <motion.div className={s.brand} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...toMotion(SPRINGS.soft), delay: reduce ? 0 : 0.35 }}>
        <h1>LUME</h1>
        <p>{businessName}</p>
      </motion.div>
      <motion.div ref={card} className={s.card} initial={{ opacity: 0, y: 18, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ ...toMotion(SPRINGS.soft), delay: reduce ? 0 : 0.56 }}>
        <AnimatePresence mode="wait" initial={false}>
          {step === "password" ? (
            <motion.form key="pw" onSubmit={submit} noValidate initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={toMotion(SPRINGS.default)}>
              <div className={s.field}>
                <label htmlFor="email">Email</label>
                <input id="email" name="email" type="email" autoComplete="username" required className={s.input} />
              </div>
              <div className={s.field}>
                <label htmlFor="password">Password</label>
                <input id="password" name="password" type="password" autoComplete="current-password" required className={s.input} aria-invalid={error ? true : undefined} aria-describedby={error ? "signin-error" : undefined} />
              </div>
              {error && <p id="signin-error" role="alert" className={s.error}>{error}</p>}
              <Button type="submit" variant="primary" className={s.submit} loading={busy}>Sign in</Button>
              <div className={s.fine}>
                <span>Private workspace. Invite only.</span>
                <a href="/forgot-password">Forgot password?</a>
              </div>
            </motion.form>
          ) : (
            <motion.div key="otp" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }} transition={toMotion(SPRINGS.default)}>
              <p className={s.otpTitle}>Two-step check</p>
              <p className={s.otpSub}>Enter the 6-digit code from your authenticator app.</p>
              <OtpInput key={otpKey} onComplete={verify} disabled={busy} />
              {error && <p role="alert" className={s.error} style={{ textAlign: "center", marginTop: 10 }}>{error}</p>}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
```

`apps/web/src/app/sign-in/page.tsx`:
```tsx
"use client";
import { useRouter } from "next/navigation";
import { SignInForm } from "@/components/auth/SignInForm";
import s from "@/components/auth/auth.module.css";
import { signIn, verifyOtp } from "@/lib/auth-client";

export default function SignInPage() {
  const router = useRouter();
  return (
    <div className={s.page}>
      <div className={s.aura} aria-hidden><i /><i /></div>
      {/* Phase 1: the business name comes from public settings. */}
      <SignInForm businessName="Nupuur Coaching" onSignIn={signIn} onVerify={verifyOtp} onSuccess={() => router.replace("/today")} />
    </div>
  );
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run --project @lume/web && pnpm --filter @lume/web typecheck'`
Expected: auth-client (3), OtpInput (4), SignInForm (4) pass with the rest.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): sign-in with logo bloom, generic errors, and a six-box two-step code

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Design showcase, Playwright (visual + axe), CI e2e

**Files:**
- Create: `apps/web/src/app/design/page.tsx`, `apps/web/src/app/design/Showcase.tsx`, `apps/web/playwright.config.ts`, `apps/web/e2e/shell.spec.ts`, `apps/web/e2e/a11y.spec.ts`, `apps/web/e2e/visual.spec.ts`
- Modify: `infra/toolbox/Dockerfile`, `.github/workflows/ci.yml`, `apps/web/package.json` (scripts), `.gitignore`

**Interfaces:**
- Produces: `/design`, a showcase of every primitive, available when `NODE_ENV !== "production"` or `LUME_DESIGN_SHOWCASE=1`. Playwright `pnpm --filter @lume/web e2e` runs against `next start` on 127.0.0.1:3100 inside the toolbox. Snapshots live in `apps/web/e2e/__screenshots__/`.

- [ ] **Step 1: Toolbox gets browser system dependencies**

Append to `infra/toolbox/Dockerfile`:
```dockerfile
# Chromium system libraries for Playwright (browsers themselves are cached in the pnpm-store volume).
RUN npx -y playwright@1 install-deps chromium && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/pnpm-store/ms-playwright
```
Run: `scripts/dev.sh toolbox`

- [ ] **Step 2: Dependencies, config, scripts**

Run: `scripts/dev.sh add --filter @lume/web -D @playwright/test @axe-core/playwright`

`apps/web/playwright.config.ts`:
```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.GITHUB_ACTIONS ? [["github"], ["list"]] : "list",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" } },
  use: { baseURL: "http://127.0.0.1:3100", reducedMotion: "reduce", viewport: { width: 1366, height: 800 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 800 } } }],
  webServer: {
    command: "pnpm build && pnpm start -p 3100 -H 127.0.0.1",
    url: "http://127.0.0.1:3100/sign-in",
    timeout: 240_000,
    reuseExistingServer: false,
    env: { LUME_DESIGN_SHOWCASE: "1", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
```
Add to `apps/web/package.json` scripts: `"e2e": "playwright install chromium && playwright test"`. Also make `apps/web/vitest.config.ts` exclude `e2e/**` (its `include` already limits to `src/**`). Add `apps/web/test-results/` and `apps/web/playwright-report/` to `.gitignore`.

- [ ] **Step 3: Write the e2e tests (they fail: no /design page yet)**

`apps/web/e2e/shell.spec.ts`:
```ts
import { expect, test } from "@playwright/test";

test("root redirects to Today and the shell shows the lockup", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/today$/);
  const lockup = page.getByTestId("lockup");
  await expect(lockup).toContainText("LUME");
  await expect(lockup).toContainText("Nupuur Coaching");
});

test("sidebar navigation updates the URL, title and current item", async ({ page }) => {
  await page.goto("/today");
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Analytics");
  await expect(page.getByRole("link", { name: "Analytics" })).toHaveAttribute("aria-current", "page");
});

test("theme choice survives a reload (server-rendered, no flash)", async ({ page }) => {
  await page.goto("/today");
  await page.getByRole("radio", { name: "Obsidian" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "obsidian");
});

test("Ctrl+K opens the palette and Enter navigates", async ({ page }) => {
  await page.goto("/today");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("lead");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/leads$/);
});

test("every response carries a nonce CSP", async ({ page }) => {
  const res = await page.goto("/sign-in");
  expect(res?.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-/);
});
```

`apps/web/e2e/a11y.spec.ts`:
```ts
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const theme of ["porcelain", "obsidian"] as const) {
  for (const path of ["/sign-in", "/today", "/design"]) {
    test(`${path} has no axe violations (${theme})`, async ({ page, context }) => {
      await context.addCookies([{ name: "lume_theme", value: theme, url: "http://127.0.0.1:3100" }]);
      await page.goto(path);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }
}
```

`apps/web/e2e/visual.spec.ts`:
```ts
import { expect, test } from "@playwright/test";

for (const theme of ["porcelain", "obsidian"] as const) {
  test.describe(theme, () => {
    test.beforeEach(async ({ context }) => {
      await context.addCookies([{ name: "lume_theme", value: theme, url: "http://127.0.0.1:3100" }]);
    });
    for (const [name, path] of [["design", "/design"], ["sign-in", "/sign-in"], ["today", "/today"]] as const) {
      test(name, async ({ page }) => {
        await page.goto(path);
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${name}-${theme}.png`, { fullPage: true });
      });
    }
  });
}
```

Run: `scripts/dev.sh run bash -c 'cd apps/web && pnpm e2e'`
Expected: FAIL. `/design` returns 404, and snapshots are missing.

- [ ] **Step 4: Implement the showcase**

`apps/web/src/app/design/page.tsx`:
```tsx
import { notFound } from "next/navigation";
import { Showcase } from "./Showcase";

export const metadata = { title: "Design system · LUME" };

export default function DesignPage() {
  if (process.env.NODE_ENV === "production" && process.env.LUME_DESIGN_SHOWCASE !== "1") notFound();
  return <Showcase />;
}
```

`apps/web/src/app/design/Showcase.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { CheckCircle } from "@/components/ui/CheckCircle";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Kbd } from "@/components/ui/Kbd";
import { Odometer } from "@/components/ui/Odometer";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";

const SWATCHES = ["canvas", "sheet", "sunk", "text", "text-2", "text-3", "accent", "danger", "warn", "meet", "ok", "cyan", "wa"];
const section = { padding: "24px 0", borderTop: "0.5px solid var(--line)" } as const;
const row = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } as const;

export function Showcase() {
  const [range, setRange] = useState<"7" | "30" | "90">("30");
  const [cmp, setCmp] = useState(false);
  const [done, setDone] = useState(false);
  const [n, setN] = useState(42500);
  const { toast } = useToast();
  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "36px 24px 120px", background: "var(--sheet)", minHeight: "100vh" }}>
      <div style={{ ...row, justifyContent: "space-between" }}>
        <h1 className="t-page">LUME design system</h1>
        <ThemeToggle initial="system" />
      </div>
      <p className="t-meta" style={{ marginTop: 6 }}>Every primitive, in both themes. Visual snapshots and accessibility checks run against this page.</p>

      <section style={section}>
        <h2 className="t-section">Colour tokens</h2>
        <div style={{ ...row, marginTop: 12 }}>
          {SWATCHES.map((t) => (
            <div key={t} style={{ textAlign: "center", fontSize: 11, color: "var(--text-2)" }}>
              <div style={{ width: 56, height: 40, borderRadius: 10, background: `var(--${t})`, boxShadow: "inset 0 0 0 0.5px var(--line-2)" }} />
              {t}
            </div>
          ))}
        </div>
      </section>

      <section style={section}>
        <h2 className="t-section">Buttons</h2>
        <div style={{ ...row, marginTop: 12 }}>
          <Button variant="primary">Save changes</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="whatsapp">Send on WhatsApp</Button>
          <Button variant="danger">End sessions</Button>
          <Button variant="primary" loading>Saving</Button>
          <Button size="sm">Small</Button>
          <Kbd>Ctrl K</Kbd>
        </div>
      </section>

      <section style={section}>
        <h2 className="t-section">Chips and avatars</h2>
        <div style={{ ...row, marginTop: 12 }}>
          <Chip tone="danger" dot>Overdue</Chip>
          <Chip tone="warn" dot>Due soon</Chip>
          <Chip tone="meet" dot>Meeting</Chip>
          <Chip tone="ok" dot>Won</Chip>
          <Chip tone="accent" selected>Selected</Chip>
          <Avatar name="Aisha Khan" />
          <Avatar name="Rohan Malik" />
          <Avatar name="Tasneem" size={40} />
        </div>
      </section>

      <section style={section}>
        <h2 className="t-section">Controls</h2>
        <div style={{ ...row, marginTop: 12 }}>
          <SegmentedControl label="Range" value={range} options={[{ value: "7", label: "7D" }, { value: "30", label: "30D" }, { value: "90", label: "90D" }]} onChange={setRange} />
          <Switch checked={cmp} onChange={setCmp} label="Compare to previous" />
          <CheckCircle checked={done} onChange={setDone} label="Mark follow-up done" />
        </div>
      </section>

      <section style={section}>
        <h2 className="t-section">Numbers and progress</h2>
        <div style={{ ...row, marginTop: 12, fontSize: 26, fontWeight: 660, letterSpacing: "-0.03em" }}>
          <span>AED&nbsp;</span>
          <Odometer value={n} format={(v) => v.toLocaleString("en-US")} label="Revenue" />
          <Button size="sm" onClick={() => setN((v) => v + 1375)}>+1,375</Button>
          <ProgressRing value={0.66} label="Cleared today" />
        </div>
      </section>

      <section style={section}>
        <h2 className="t-section">Feedback</h2>
        <div style={{ ...row, marginTop: 12 }}>
          <Button onClick={() => toast({ tone: "ok", title: "Follow-up done", detail: "Aisha Khan · 3 of 6 cleared", sound: "done", action: { label: "Undo", onClick: () => undefined } })}>Success toast</Button>
          <Button onClick={() => toast({ tone: "warn", title: "Snoozed until tomorrow 10:00" })}>Silent toast</Button>
        </div>
        <div style={{ display: "grid", gap: 8, marginTop: 16, maxWidth: 420 }}>
          <Skeleton width={140} height={12} />
          <Skeleton height={34} />
          <Skeleton height={60} radius={12} />
        </div>
      </section>

      <section style={section}>
        <EmptyState title="You’re all caught up" body="Nothing needs you right now. New follow-ups and bookings will land here." />
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Generate baselines, then run everything**

Run:
```bash
scripts/dev.sh run bash -c 'cd apps/web && pnpm exec playwright install chromium && pnpm exec playwright test --update-snapshots && pnpm exec playwright test'
scripts/dev.sh fetch $(ssh lumedev 'cd /root/lume-dev/src && git status --porcelain -uall apps/web/e2e/__screenshots__ | awk "{print \$NF}"')
```
Expected: the second run reports all e2e, axe and visual tests passing. Six PNG baselines are fetched to the PC. **Open each PNG and review it against the prototypes** (`docs/design/prototypes/`) before committing. A baseline is a claim that the screen looks right.

If axe reports a real violation (contrast, missing name, landmark), fix the component or token, not the test.

- [ ] **Step 6: CI runs e2e inside the toolbox image**

Add this job to `.github/workflows/ci.yml` (same level as `check`):
```yaml
  e2e:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - name: Toolbox image (same environment as local runs, so screenshots match)
        run: docker build -t lumedev-toolbox infra/toolbox
      - name: Playwright in the toolbox
        run: |
          docker run --rm -v "$PWD:/repo" -w /repo -e CI=1 -e GITHUB_ACTIONS=true lumedev-toolbox \
            bash -lc 'pnpm install --frozen-lockfile && cd apps/web && pnpm e2e'
```

- [ ] **Step 7: Full suite, commit, push, watch CI**

Run: `scripts/dev.sh run bash -c 'pnpm lint && pnpm typecheck && pnpm test' && scripts/dev.sh fmt`
Then:
```bash
git add -A
git commit -m "feat(web): design showcase with Playwright visual snapshots and axe checks in both themes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin main
```
Watch the run at `https://github.com/kedar2812/lume-v3/actions` until `check`, `e2e` and `images` are green.

---

### Task 11: Live check on the stack and owner demo

- [ ] **Step 1: Rebuild and smoke the stack**

Run: `scripts/dev.sh up && scripts/dev.sh remote bash infra/scripts/smoke.sh`
Expected: `smoke passed`. The smoke test's "web page renders" check now follows the `/` → `/today` redirect. If it fails because the root is a redirect, change `page_has_brand` in `infra/scripts/smoke.sh` to `c -L "$base/" | grep -q LUME`.

- [ ] **Step 2: Demo**

Ask the owner to run `bash scripts/dev.sh tunnel` and open `https://lume.localhost:8443/sign-in`, `/today` and `/design` (the showcase is only enabled in the dev stack via `LUME_DESIGN_SHOWCASE=1`; add it to the `web` service environment in `infra/compose.dev.yml`). Confirm both themes, the nav pill, page transitions, Ctrl+K, toasts with sound and the sign-in bloom.
