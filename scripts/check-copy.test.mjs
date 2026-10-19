import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const script = path.resolve(import.meta.dirname, "check-copy.mjs");

function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "copy-"));
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

test("fails on an em dash between words in a string or JSX text, naming file and line", () => {
  const dir = repo({
    "apps/web/src/a.tsx": 'const t = "Sent — thank you.";\n',
    "apps/web/src/b.tsx": "<p>\n  You can close this —\n  LUME will tell you.\n</p>\n",
    "packages/core/src/c.ts": 'message: "Some characters may be wrong — check the accents.",\n',
  });
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /apps\/web\/src\/a\.tsx:1/);
  assert.match(r.out, /apps\/web\/src\/b\.tsx:2/);
  assert.match(r.out, /packages\/core\/src\/c\.ts:1/);
});

test("leaves the lone placeholder dash, comments, tests and the legal documents alone", () => {
  const dir = repo({
    "apps/web/src/cell.tsx": 'return v ?? <span>—</span>;\nconst x = v === null ? "—" : pct(v);\n',
    "apps/web/src/note.tsx":
      "// LUME AI — the loop\n/* one — two */\n/**\n * a — b\n */\nconst y = 1; // tidy — here\n",
    "apps/web/src/a.test.tsx": 'expect(t).toBe("Sent — thank you.");\n',
    "packages/core/src/legal/documents.ts": '"Important actions — signing in — are recorded",\n',
    "docs/spec.md": "Plain — prose in docs is fine.\n",
  });
  const r = run(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /check-copy: clean/);
});
