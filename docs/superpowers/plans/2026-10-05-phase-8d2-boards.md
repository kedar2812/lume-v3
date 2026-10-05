# Phase 8D-2: the shared controls and every board, to the canvas — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline, on main). Steps are TDD where there
> is logic; every screen is checked beside its canvas board, in both themes, before its task is complete.

**Goal:** every Analytics board matches its approved canvas board card for card, in Porcelain and Obsidian, with
honest numbers from the 8D-1 engine.

**Architecture:** the API (8D-1) already serves every number; this plan is the web. Shared pieces first (bar, numbers,
charts, drill sheet), then one board per task, each built from its canvas board's own markup and logic
(`docs/design/phase8/canvas/<Board>.dc.html`, rendered to `docs/design/phase8/screens/<Board>-<theme>.png` by
`apps/web/scripts/render-canvas.mjs`).

**Tech stack:** Next.js (apps/web), CSS modules with the LUME tokens, motion/react springs, vitest + Testing Library,
Playwright (`analytics-review` project) for full-page screenshots on the demo business.

**Spec:** `docs/superpowers/specs/2026-10-04-phase-8d-analytics-to-canvas-design.md` §2 (acceptance), §5 (shared
controls), §6 (boards). Approved by the owner 2026-10-04.

## Global constraints

- Card for card with the canvas; wording only where the engine is more honest (ledger each difference).
- Every chart: nice ticks (1/2/5 × 10ⁿ), a sparkline only with ≥3 points, bars under 7 days, hover tooltip "Click to
  see these leads", click opens the drill, keyboard focus, a visually hidden table.
- Money in the business currency (₹ L/Cr for INR; K/M elsewhere). Trend chips by the owner's rule (as built).
- Reduced motion: odometers, morphs and rings become fades. axe: no violations.
- Thin data reads "Early days", never fake trends. Every board checked full (demo business) and empty (fresh install).
- No violet; meetings blue + sky; switches green when on; full-window scrim for sheets.

## Review focus

1. A board at 1366 × 800 (the owner's laptop) — cards wrap, nothing clips, the bar fits.
2. Obsidian — every chart colour and hatching legible; tooltips not white-on-white.
3. A rep (own scope) — tabs it can't use absent, no money without analytics.revenue.
4. A range change while a board loads — no stale numbers from the old range.
5. Thousands of leads — numbers grouped, long names ellipsised, tables scroll inside their card.

## Tasks

1. **Canvas renders + review harness.** Render all 12 boards in both themes; an `analytics-review` Playwright
   project that seeds the demo business (apps/api/src/demo/seed.ts) and screenshots every board in both themes at
   1440 × 900 and 1366 × 800 into `apps/web/e2e/__review__/analytics/`.
2. **Shared controls.** The bar (tabs, range picker — done, Filters button with count, Export); Odometer numbers;
   chart kit (nice ticks, hover/tooltip/click-to-drill, hidden table, keyboard); the headline table in `@lume/core`
   (shared with the weekly email; "Early days" under 30 new leads); drill sheet footer (Open these N in Leads, Export
   CSV with permission, "Only what you're allowed to see").
3. **Overview** to Main.
4. **Funnel** to Funnel.
5. **Team** to Team.
6. **Revenue & sources** to Revenue.
7. **Lost** to Lost.
8. **Timing & meetings** to Timing.
9. **Templates & data** to Quality.
10. **The rep's view** to Rep (My numbers / My funnel / My timing).
11. **Review:** every board beside its canvas board, both themes, both sizes, full and empty; a fresh opus reviewer;
    one fix pass; ledger closed.
