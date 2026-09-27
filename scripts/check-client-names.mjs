// Fails when a known client's name appears in code (CLAUDE.md; licensing spec §0 and §9). The list holds
// sha256 hashes of lower-cased words, so this public repository never carries the names themselves.
// Docs are exempt: the project report and specs may name the first customer.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOTS = ["apps", "packages", "infra", "scripts", ".github"];
const LIST = "scripts/client-names.sha256";
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|bin|age|zip|gz|pdf)$/i;

const hashes = new Set(
  readFileSync(LIST, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f]{64}$/.test(l)),
);
const files = execFileSync("git", ["ls-files", "--", ...ROOTS], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && f !== LIST && !BINARY.test(f));

const hits = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue; // listed but deleted in the working tree
  }
  text.split("\n").forEach((line, i) => {
    for (const w of line.toLowerCase().match(/[a-z]{4,}/g) ?? [])
      if (hashes.has(createHash("sha256").update(w).digest("hex"))) {
        hits.push(`${f}:${i + 1}`);
        break;
      }
  });
}
if (hits.length) {
  console.error(
    `A client's name appears in code (use the fictional Brightpath Studio fixtures instead):\n  ${hits.join("\n  ")}`,
  );
  process.exit(1);
}
console.log("check-client-names: clean");
