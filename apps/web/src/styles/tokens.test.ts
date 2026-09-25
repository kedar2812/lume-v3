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
  ])("%s: white text on every -fill token reaches 4.5:1 (filled buttons)", (_name, t) => {
    for (const k of ["--accent-fill", "--wa-fill", "--danger-fill"]) {
      expect(contrastRatio("#ffffff", t[k]!), k).toBeGreaterThanOrEqual(4.5);
    }
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
  ])("%s: tertiary text is real text too: 4.5:1 on every surface it sits on", (_name, t) => {
    for (const bg of ["--sheet", "--sunk", "--canvas", "--raised"]) {
      expect(contrastRatio(t["--text-3"]!, t[bg]!), bg).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("obsidian: every layer steps clearly up from the one below (page → card → popover)", () => {
    // Too little step and cards melt into the page (the owner's call: "blended in").
    expect(contrastRatio(dark["--sheet"]!, dark["--canvas"]!)).toBeGreaterThanOrEqual(1.14);
    expect(contrastRatio(dark["--raised"]!, dark["--sheet"]!)).toBeGreaterThanOrEqual(1.1);
    // Inputs and table headers sit recessed inside a card, never above it.
    expect(contrastRatio(dark["--sheet"]!, dark["--sunk"]!)).toBeGreaterThanOrEqual(1.1);
  });
});
