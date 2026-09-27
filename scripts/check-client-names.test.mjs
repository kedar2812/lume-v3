import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const script = path.resolve(import.meta.dirname, "check-client-names.mjs");
const sha = (w) => createHash("sha256").update(w).digest("hex");

function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "names-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), body);
  }
  execFileSync("git", ["add", "."], { cwd: dir });
  return dir;
}
const run = (dir) => {
  try {
    return { code: 0, out: execFileSync("node", [script], { cwd: dir, encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

test("fails on a listed name in code, case-insensitively, naming file and line", () => {
  const dir = repo({
    "scripts/client-names.sha256": `${sha("acmecorp")}\n`,
    "apps/web/a.ts": "const x = 1;\nconst owner = 'AcmeCorp Ltd';\n",
  });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /apps\/web\/a\.ts:2/);
  assert.doesNotMatch(r.out, /acmecorp/i); // never prints the name itself
});

test("ignores docs and passes a clean tree", () => {
  const dir = repo({
    "scripts/client-names.sha256": `${sha("acmecorp")}\n`,
    "docs/report.md": "AcmeCorp is the first customer.\n",
    "packages/core/b.ts": "export const y = 2;\n",
  });
  assert.equal(run(dir).code, 0);
});
