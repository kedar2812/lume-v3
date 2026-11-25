import type { Page } from "@playwright/test";

/** Wait for the page to be visually settled: fonts loaded, no running animations, a short idle. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const still = () =>
    page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, {
      timeout: 8000,
    });
  try {
    await still();
  } catch {
    // On a busy box the browser can go seconds without a frame, so a drawer's slide-in is still mid-way when the
    // wait ends (gate 34, 2026-11-25: it passed 3 of 3 alone). An animation with an end is taken to it once; one
    // without an end, or one that keeps starting again (a component mounting over and over), still fails below.
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        const end = a.effect?.getComputedTiming().endTime;
        if (a.playState === "running" && typeof end === "number" && Number.isFinite(end)) a.finish();
      }
    });
    try {
      await still();
    } catch (e) {
      // Say which animations never stopped, so a timeout names its cause.
      const running = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((a) => a.playState === "running")
          .map((a) => {
            const el = (a.effect as KeyframeEffect | null)?.target as Element | null;
            const name = (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id;
            return `${name || "(script)"} on ${el ? `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}` : "?"}`;
          }),
      );
      throw new Error(`the page never settled; still running: ${running.join("; ") || "(none now)"}`, {
        cause: e,
      });
    }
  }
  await page.waitForTimeout(600);
}

/**
 * A glass panel opened from the lead drawer (the follow-up and send sheets) is drawn a little differently on each page
 * load: measured 2026-11-07, its layout was identical to 1/64 px across runs and its picture held still within a page,
 * yet single glyphs and the focus ring differed between loads by up to 3,039 of its ~157,000 pixels (CI: ~1,500), and
 * neither waiting, opening it without its animation nor repainting it changed that. Up to 5,000 may differ; a moved or
 * cut-off row is caught by opened.spec and the drawer's own pictures.
 */
export const GLASS_TEXT = { maxDiffPixels: 5000 };
