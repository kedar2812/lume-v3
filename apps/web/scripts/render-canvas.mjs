// Renders the approved Phase 8 canvas (docs/design/phase8/canvas, the Design artifact's own boards and runtime) to
// screenshots, in both themes, so a built screen can be checked beside its board. Run from apps/web:
//   node scripts/render-canvas.mjs
// page.evaluate callbacks run in the page.
/* global document, getComputedStyle */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const here = resolve(import.meta.dirname, "..");
const canvas = resolve(here, "../../docs/design/phase8/canvas");
const out = resolve(here, "../../docs/design/phase8/screens");
const work = join(tmpdir(), "lume-canvas");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(canvas, "support.js"), join(work, "support.js"));
copyFileSync(resolve(here, "public/lume-mark.png"), join(work, "lume-mark.png"));

const boards = readdirSync(canvas).filter((f) => f.endsWith(".dc.html"));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
for (const file of boards) {
  for (const theme of ["porcelain", "obsidian"]) {
    const src = readFileSync(join(canvas, file), "utf8")
      // The theme a board opens in is its "theme" prop's default.
      .replace(/("theme":\s*\{[^}]*"default":\s*")porcelain(")/, `$1${theme}$2`)
      // Uploads (the LUME mark) live in the canvas's own store: the file the app ships stands in.
      .replace(/\/_blob\/[0-9a-f]{32}/g, "./lume-mark.png");
    const name = `${file.replace(".dc.html", "")}-${theme}`;
    writeFileSync(join(work, `${name}.html`), src);
    await page.goto(`file://${join(work, `${name}.html`)}`);
    // Springs, odometers and charts settle.
    await page.waitForTimeout(2600);
    await page.screenshot({ path: join(out, `${name}.png`) });
    // A board scrolls inside its window frame: capture the rest of it, a screen at a time ("-2", "-3", …).
    const pages = await page.evaluate(() => {
      const el = [...document.querySelectorAll("*")]
        .filter(
          (e) => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY.match(/auto|scroll/),
        )
        .sort((a, b) => b.clientHeight - a.clientHeight)[0];
      if (!el) return 0;
      el.setAttribute("data-render-scroll", "");
      return Math.ceil((el.scrollHeight - el.clientHeight) / (el.clientHeight - 80));
    });
    for (let i = 1; i <= Math.min(pages, 4); i++) {
      await page.evaluate((i) => {
        const el = document.querySelector("[data-render-scroll]");
        el.scrollTop = i * (el.clientHeight - 80);
      }, i);
      await page.waitForTimeout(1400);
      await page.screenshot({ path: join(out, `${name}-${i + 1}.png`) });
    }
    console.log("rendered", name, pages + 1, "screens");
  }
}
await browser.close();
