import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LUME never guesses anyone's gender (owner, 2026-10-05): what it notices about a person names them ("Dev’s
 * follow-ups…", "7 of Dev’s 10…") or speaks to them ("Your follow-ups…"), never "he", "she", "his" or "her".
 * Checked over every string in the files that write about people, so a new detector can't slip one in.
 */
const FILES = [
  resolve(import.meta.dirname, "insights.ts"),
  resolve(import.meta.dirname, "../../../../apps/api/src/modules/analytics/weekly.ts"),
];
const GENDERED = /\b(he|she|him|his|her|hers|himself|herself)\b/i;
/** The text of every string and template literal in a source file (comments left out). */
function strings(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return [...noComments.matchAll(/`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g)].map(
    (m) => m[0],
  );
}

describe("no guessed gender in what LUME writes about people", () => {
  it.each(FILES)("%s: no he, she, his or her in any string", (file) => {
    const found = strings(readFileSync(file, "utf8")).filter((s) => GENDERED.test(s));
    expect(found).toEqual([]);
  });

  it("the check itself catches one", () => {
    expect(
      strings("const t = `9 of his 12 late follow-ups`; // his").filter((s) => GENDERED.test(s)),
    ).toHaveLength(1);
    expect(strings("// he said\nconst t = 'Dev’s follow-ups';").filter((s) => GENDERED.test(s))).toHaveLength(
      0,
    );
  });
});
