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
});
