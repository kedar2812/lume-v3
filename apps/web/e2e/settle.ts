import type { Page } from "@playwright/test";

/** Wait for the page to be visually settled: fonts loaded, no running animations, a short idle. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  try {
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, {
      timeout: 8000,
    });
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
  await page.waitForTimeout(600);
}
