import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");
const cssFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? cssFiles(full) : name.endsWith(".css") ? [full] : [];
  });

describe("stylesheets", () => {
  // Found in the production build: with "-webkit-backdrop-filter" written after "backdrop-filter", the
  // CSS compiler kept only the prefixed one, so Chrome drew every glass surface with no blur at all.
  // Vendor prefixes are the compiler's job; the source says each property once, unprefixed.
  it("never hand-writes a vendor-prefixed property", () => {
    const offenders = cssFiles(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line: line.trim(), at: `${path.relative(SRC, file)}:${i + 1}` }))
        .filter(
          ({ line }) =>
            /^-(webkit|moz|ms)-[a-z-]+\s*:/.test(line) && !line.startsWith("-webkit-font-smoothing"),
        )
        .map(({ line, at }) => `${at} ${line}`),
    );
    expect(offenders).toEqual([]);
  });

  // The owner, 2026-10-03: a popup's background is covered completely — the whole window dims and blurs, never a
  // part of it. Every rule that dims with --scrim blurs with --scrim-blur too (the one look), unless the layer
  // behind it is already blurred itself.
  it("every scrim dims and blurs, with the one shared blur", () => {
    const ownBlur = ["onboarding/onboarding.module.css"]; // the app behind the welcome is a blurred copy already
    const offenders = cssFiles(SRC).flatMap((file) => {
      const rel = path.relative(SRC, file).replaceAll("\\", "/");
      if (ownBlur.some((f) => rel.endsWith(f))) return [];
      return readFileSync(file, "utf8")
        .split("}")
        .filter((block) => /background:\s*var\(--scrim\)\s*;/.test(block))
        .filter((block) => !/backdrop-filter:\s*var\(--scrim-blur\)/.test(block))
        .map((block) => `${rel} ${block.split("{")[0]!.trim().split("\n").pop()}`);
    });
    expect(offenders).toEqual([]);
  });
});
