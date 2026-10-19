// Fails when an em dash is used as punctuation in words people read (the owner's copy rule: LUME speaks plainly,
// with no em dashes). A lone "—" standing for "no value" in a cell is a placeholder, not punctuation, and stays.
// Comments, tests and the legal documents (whose wording is the owner's, under LEGAL_DRAFT) are not checked.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOTS = ["apps", "packages"];
const SOURCE = /\/src\/.*\.(ts|tsx)$/;
const SKIP = [/\.test\.tsx?$/, /\/test-[^/]*\.ts$/, /\/testing\//, /\/legal\/documents\.ts$/];
// A dash between words: "this — that", or a line that starts or ends a sentence with one.
const PROSE = /[\p{L}\p{N}.,)'"’”]\s+—\s+[\p{L}\p{N}'"‘“(]|^\s*—\s+\p{L}|\p{L}\s+—\s*$/u;

const files = execFileSync("git", ["ls-files", "--", ...ROOTS], { encoding: "utf8" })
  .split("\n")
  .filter((f) => SOURCE.test(f) && !SKIP.some((s) => s.test(f)));

const hits = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue; // listed but deleted in the working tree
  }
  let inBlock = false;
  text.split("\n").forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      if (!line.includes("*/")) return;
      line = line.slice(line.indexOf("*/") + 2);
      inBlock = false;
    }
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) return;
    if (t.startsWith("/*") || t.startsWith("{/*")) {
      if (!t.includes("*/")) inBlock = true;
      return;
    }
    // A comment at the end of a line of code.
    line = line.replace(/\s\/\/\s.*$/, "").replace(/\{?\/\*.*?\*\/\}?/g, "");
    if (PROSE.test(line)) hits.push(`${f}:${i + 1}: ${raw.trim().slice(0, 120)}`);
  });
}
if (hits.length) {
  console.error(
    `An em dash is used as punctuation in copy people read (use a comma, colon, full stop or brackets):\n  ${hits.join("\n  ")}`,
  );
  process.exit(1);
}
console.log("check-copy: clean");
