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
        [...m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [
          d[1]!,
          d[2]!.replace(/\s+/g, " ").trim(),
        ]),
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
    for (const k of [
      "--text",
      "--text-2",
      "--danger-ink",
      "--warn-ink",
      "--ok-ink",
      "--meet-ink",
      "--accent-ink",
    ]) {
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
