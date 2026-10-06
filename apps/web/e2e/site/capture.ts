import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import sharp from "sharp";

/** A capture as WebP, the same pixels, quality 86 (text stays crisp at 2×). */
export async function toWebp(png: Buffer, out: string, quality = 86) {
  mkdirSync(path.dirname(out), { recursive: true });
  const info = await sharp(png).webp({ quality, effort: 5, smartSubsample: true }).toFile(out);
  return { width: info.width, height: info.height, bytes: info.size };
}

export type Rect = { x: number; y: number; w: number; h: number };

/** Each selector's first match, as a viewport box in CSS px (the website's hero cuts its tiles from the capture). */
export async function rectsOf(page: Page, selectors: Record<string, string>): Promise<Record<string, Rect>> {
  const out: Record<string, Rect> = {};
  for (const [name, sel] of Object.entries(selectors)) {
    const b = await page.locator(sel).first().boundingBox({ timeout: 5_000 });
    if (!b) throw new Error(`no box for ${name} (${sel})`);
    out[name] = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  }
  return out;
}

export type StoryRule = { what: string; check: (page: Page) => Promise<boolean> };

/** The rules a capture must meet before it's taken (website spec §4.1): the broken ones, in words. */
export async function checkStory(page: Page, rules: StoryRule[]): Promise<string[]> {
  const broken: string[] = [];
  for (const r of rules) {
    const ok = await r.check(page).catch((e: Error) => e);
    if (ok !== true)
      broken.push(ok instanceof Error ? `${r.what} (${ok.message.split(/\r?\n/)[0]})` : r.what);
  }
  return broken;
}
