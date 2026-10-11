/* global document */
// Renders scripts/tour/flow.html (or any HTML/CSS animation) frame by frame: every animation is paused and seeked
// to each frame's time, so the motion is exact at any frame rate. node render-anim.mjs <html> <out-dir> [seconds] [fps]
import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [, , html, outDir, seconds = "6.5", fps = "60", stills = ""] = process.argv;
// CHROME: a Chromium to use (playwright-core ships none); otherwise Playwright's own install.
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await p.goto(pathToFileURL(path.resolve(html)).href);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(300);
const at = async (ms) =>
  p.evaluate(
    (ms) =>
      document.getAnimations().forEach((a) => {
        a.pause();
        a.currentTime = ms;
      }),
    ms,
  );
if (stills) {
  for (const s of stills.split(",")) {
    await at(Number(s) * 1000);
    await p.screenshot({ path: `${outDir}/still_${s}.png` });
  }
} else {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const n = Math.round(Number(seconds) * Number(fps));
  for (let i = 0; i < n; i++) {
    await at((i * 1000) / Number(fps));
    await p.screenshot({ path: `${outDir}/${String(i).padStart(5, "0")}.png` });
  }
  console.log(`${n} frames`);
}
await b.close();
