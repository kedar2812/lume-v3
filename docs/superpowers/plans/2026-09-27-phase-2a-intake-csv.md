# Plan 2A — Intake engine, CSV import and the bulk phone fix: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone with "Import leads" can bring a CSV of leads into LUME — a one-time migration or an occasional list — with every value checked, every duplicate merged instead of copied, every row accounted for, and nothing their role hides revealed; and anyone who can bulk-edit can give unreadable phone numbers their country in one action.

**Architecture:** A pure engine in `packages/core/src/intake/` (read the file, suggest a mapping, map one row) is shared by the API's preview and the import job. The job is a pg-boss queue (`imports.run`) consumed **inside the API process** as `lume_app`, so every row is written through the same lead-writing code as a hand-made lead, in its own transaction scoped to the importer. Four new tables (`lead_sources`, `imports`, `import_rows`, `import_mapping_memory`) make every row write-once and every run resumable.

**Tech Stack:** TypeScript (strict), Fastify 5 + Zod 4 + Drizzle, Postgres 17 with forced RLS, pg-boss 10, Papa Parse 5 (new, in `@lume/core`), Next.js 16 App Router + motion 12, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-27-phase-2-intake-design.md` (§1–§11 for 2A). Read it before any task; section numbers below (§6.7 etc.) refer to it.

## Spec amendments decided while planning (recorded here and in the spec)

1. **The job runs in the API process, not the worker (§4.5, §7).** Migration 0009 revokes every lead table from `lume_worker` on purpose. Rather than weaken that, the API registers a pg-boss worker for `imports.run` and runs each row as `lume_app` with the importer's user id and `lume.lead_scope = 'all'` for that row's transaction only. The worker keeps only the retention sweep, on intake tables, never lead tables.
2. **The lead-writing code stays in the API** (§6.10 said `packages/db`). It moves from `createLead` into `apps/api/src/modules/leads/writer.ts` (`insertLead`, `mergeIntoLead`), which both `createLead` and the import job call. The job reaches it through a small facade that gives it a request-shaped object (`db`, `actor`, `server`, `id`, `ip`). One copy of "what creating a lead means", as the spec intends.
3. **Custom fields marked "Needed before a lead is saved" (new §6.14).** Creating a lead enforces them, and so must an import: a row without a value for one is an error — unless the importer set a default for that field in the Rules step (`rules.requiredDefaults`). The Columns step lists every such field that no column covers, before preview.
4. **"Source" is not a mapping target (new note in §5.2).** A lead's source is the import itself (`source_id`); the core "Source" field has no column of its own. A column like "Lead source" is offered as "New field…" (for example "Original source"), and the synonym table never suggests Source.

## Global Constraints

- Everything runs through the gate before a commit: `bash "$G/gate.sh"` must print `GATE_OK` (lint, typecheck, Prettier, unit + integration tests, production web build). Commit only on `GATE_OK`; push straight to `main`.
- Tests run on the build box: `scripts/dev.sh run bash -c '<command>'`. The test database must be up (`scripts/dev.sh test-db up`). If `lumedev-toolbox` is missing on the box, `scripts/dev.sh toolbox` rebuilds it.
- New dependencies only through `scripts/dev.sh add <pkg> --filter <workspace>` (lockfile resolved on the box, copied back).
- Web code imports core only from `@lume/core/shared`. Never hand-write vendor-prefixed CSS.
- Every API route is listed in `apps/api/test/probes.ts`; the permission matrix test must stay green.
- Every audit action the API writes has a phrase in `apps/web/src/lib/settings/audit.ts`, and the `WRITTEN` list in its test.
- UI copy speaks as **LUME** by name ("LUME will let you know when it's done", "LUME couldn't read row 42"), never "we".
- One business currency: an amount in any other currency is refused, never converted.
- Porcelain and Carbon (Obsidian) themes, tokens only (`var(--sheet)` etc.), 4.5:1 contrast for all text, `prefers-reduced-motion` respected, sounds only on achievements (none in this plan).
- Client-neutral (root `CLAUDE.md`): fixtures, seed data and examples use the fictional **Brightpath Studio** (owner Maya Kapoor, admin Leila Haddad, `brightpath.test`); `pnpm lint` fails on a known client's name (Task 0).
- Limits (spec §5.1): 10 MB file, 20,000 data rows, 200 columns, 10,000 characters per cell; header row among the first 10 lines; preview 20 rows; job batches of 200 rows; retention 30 days (files and raw rows), 7 days (unstarted drafts).

## Review Focus

1. **A European Excel export** (semicolon-delimited, comma decimals, `dd.mm.yyyy` dates): the delimiter, the numbers and the dates must all come out right, not "1,234" read as 1.234. → Task 2 test "a semicolon CSV with comma decimals".
2. **The same person written two ways in one file** (`+971 50 123 4567` and `050 123 4567` with default country AE): the second row must merge into the first, because dedupe runs on the normalised E.164. → Task 7 test "the same number written two ways merges".
3. **A field changes between preview and start** (the admin archives a mapped field, or a mapped option, in another tab): Start must refuse with the reason, never start a run that fails every row. → Task 6 test "start re-validates against today's fields".
4. **A double-click on Start, or two tabs pressing Start**: one run only. → Task 7 test "start twice runs once".
5. **An importer who can see only their own leads imports a file matching a colleague's lead**: the preview and report say "an existing lead", never its name or owner, and the merge still happens. → Task 7 test "a merge into a lead the importer can't see stays anonymous".

---

## File map

**Core engine** (`packages/core/src/intake/`, exported through `@lume/core` and `@lume/core/shared`):

| File | Responsibility |
|---|---|
| `read.ts` | Bytes → encoding, delimiter, header row, headers, rows, file warnings, or a refusal (§5.1) |
| `values.ts` | Pure value parsers: dates (with column order), numbers, money, booleans, email, Instagram, URL, phone extras (§6.3, §6.7, §6.8) |
| `mapping.ts` | Types (`ColumnMap`, `Rules`, `Transform`, `MappingProblem`), `validateMapping`, `suggestMapping`, the synonym table (§5.2–§5.4) |
| `map-row.ts` | `mapRow(cells, mapping, rules, ctx)` → draft or problems, plus warnings; `fingerprintOf` (§5.5, §6) |
| `index.ts` | Re-exports |
| `*.test.ts` | Table-driven tests beside each file |

**Database** (`packages/db/`): `migrations/0015_intake.sql`, `src/schema/intake.ts`, `src/schema/index.ts` (export), `src/rls.test.ts` (intake policies).

**API** (`apps/api/src/`):

| File | Responsibility |
|---|---|
| `modules/leads/writer.ts` | `insertLead(req, input)` and `mergeIntoLead(req, lead, draft, opts)` — the one lead-writing path |
| `modules/leads/service.ts` | `createLead` now calls `insertLead` |
| `modules/leads/bulk.ts` | New action `set_phone_country` |
| `modules/imports/context.ts` | `ImportContext` loader (fields, stages, people, tags, settings → `MapContext`) |
| `modules/imports/service.ts` | Drafts: upload, patch, preview, start, cancel, resume, discard, list, get, rows, errors CSV |
| `modules/imports/runner.ts` | `runImport(app, importId)`: the batch loop, per-row transaction, locks, dedupe, create/merge/skip |
| `modules/imports/job-request.ts` | `withJobRequest(app, actor, fn)`: a request-shaped facade over one transaction |
| `modules/imports/routes.ts` | The routes of spec §8 |
| `modules/imports/queue.ts` | Starts pg-boss in the API (`imports.run`), `enqueueImport(id)` |
| `app.ts`, `main.ts` | Register routes; start the queue when `deps.queue` is set |
| `test/probes.ts` | New routes |

**Worker** (`apps/worker/src/`): `maintenance.ts` gains `purgeImportFiles()`; `boss.ts` schedules it nightly.

**Web** (`apps/web/src/`):

| File | Responsibility |
|---|---|
| `lib/imports/client.ts` | `importsClient` (upload, patch, preview, start, cancel, resume, discard, list, get, rows) |
| `lib/api.ts` | `api.upload(path, bytes, headers)` for raw bodies |
| `components/imports/ImportSheet.tsx` | The full-screen flow, its step rail and draft state |
| `components/imports/FileStep.tsx` | Drop zone, refusals, reading chips, "already imported" |
| `components/imports/ColumnsStep.tsx` | Column rows, field picker, transforms |
| `components/imports/UnmatchedPanel.tsx` | Unmatched values per column: map / add / leave empty |
| `components/imports/RulesStep.tsx` | Match order, on-match, reopen, pipeline/stage, owner rule, country, no-name, required defaults |
| `components/imports/PreviewStep.tsx` | The 20-row outcome table |
| `components/imports/ProgressStep.tsx` | Progress ring, live counts, cancel, the report |
| `components/imports/imports.module.css` | Styles |
| `components/settings/ImportsList.tsx` + `app/(app)/settings/imports/page.tsx` | Settings → Imports |
| `lib/settings/areas.ts` | The "imports" area |
| `components/leads/LeadsScreen.tsx` | "Import" button with the Done badge |
| `components/leads/BulkBar.tsx`, `lib/leads/bulk.ts` | "Set country…" action and its reasons |
| `lib/settings/audit.ts` | Phrases for `import.*` |

**Client-neutral check (Task 0):** `scripts/check-client-names.mjs`, `scripts/client-names.sha256`, `scripts/check-client-names.test.mjs`, `package.json` (`lint`).

**E2E and live:** `apps/web/e2e/imports.spec.ts`, `apps/web/e2e/fixtures/*.csv`, additions to `a11y.spec.ts` and `visual.spec.ts`, `apps/web/e2e-live/acceptance-2a.mjs`, `docs/runbooks/acceptance.md`.

---

### Task 0: A client-neutral codebase, and a check that keeps it that way

`CLAUDE.md` (root) and `docs/LUME_LICENSING_DEPLOYMENT_SPEC.md` §0: LUME is a multi-client product; the first customer's names, team and setup must not appear in code, tests or seed data, and CI checks for them. Today about 100 mentions remain from the build so far (tests, e2e fixtures, acceptance scripts, two comments, `.env.example`, the design showcase), and setup pre-selects the coaching preset.

**Files:**
- Create: `scripts/check-client-names.mjs`, `scripts/client-names.sha256`, `scripts/check-client-names.test.mjs`
- Modify: `package.json` (`lint` runs the check), every file listed by `git grep -il -e nupuur -e tasneem -- apps packages infra scripts` (as of this plan: 28 + 20 files), `packages/core/src/leads/presets.ts` (comment), `apps/api/src/modules/auth/lockout.ts` (comment), `infra/.env.example`, `apps/web/src/app/design/Showcase.tsx`, `apps/web/src/components/setup/SetupWizard.tsx` (default preset), e2e screenshot baselines and aria snapshots that show the names.

**Interfaces:**
- Produces: `node scripts/check-client-names.mjs` exits 1 and prints `file:line` for any word whose sha256 is listed in `scripts/client-names.sha256`; exits 0 otherwise. The list holds hashes, never names, so the public repository doesn't carry them.
- The fictional business used everywhere from now on: **Brightpath Studio** (`brightpath.test`); owner **Maya Kapoor** (`maya@brightpath.test`); admin **Leila Haddad** (`leila@brightpath.test`). Other fixture people (Riya Sharma, Aman Verma, Noor Ahmed, Zara Malik, Omar Test) are already fictional and stay.

- [ ] **Step 1: Write the failing test** (`scripts/check-client-names.test.mjs`, run by Node's own test runner so it needs no workspace)

```js
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
    return { code: 0, out: execFileSync("node", [script], { cwd: dir, encoding: "utf8" }) };
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
```

- [ ] **Step 2: Run to see it fail**

Run: `scripts/dev.sh run bash -c 'node --test scripts/check-client-names.test.mjs'`
Expected: FAIL — `Cannot find module '.../check-client-names.mjs'`.

- [ ] **Step 3: Implement** (`scripts/check-client-names.mjs`)

```js
// Fails when a known client's name appears in code (CLAUDE.md; licensing spec §0 and §9). The list holds
// sha256 hashes of lower-cased words, so this public repository never carries the names themselves.
// Docs are exempt: the project report and specs may name the first customer.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOTS = ["apps", "packages", "infra", "scripts", ".github"];
const hashes = new Set(
  readFileSync("scripts/client-names.sha256", "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f]{64}$/.test(l)),
);
const files = execFileSync("git", ["ls-files", "--", ...ROOTS], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|bin|age|zip)$/i.test(f) && f !== "scripts/client-names.sha256");

const hits = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
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
  console.error(`A client's name appears in code (use the fictional Brightpath Studio fixtures instead):\n  ${hits.join("\n  ")}`);
  process.exit(1);
}
console.log("check-client-names: clean");
```

`scripts/client-names.sha256` — one hash per line, generated on the executor's machine and never echoed into the repo in plain text:

```bash
for w in nupuur tasneem; do printf '%s' "$w" | sha256sum | cut -d' ' -f1; done > scripts/client-names.sha256
```

`package.json`: `"lint": "eslint . && prettier --check . && node scripts/check-client-names.mjs"`.

- [ ] **Step 4: Run the unit test, then the check on the real tree**

Run: `scripts/dev.sh run bash -c 'node --test scripts/check-client-names.test.mjs && node scripts/check-client-names.mjs'`
Expected: the unit test PASSES; the real check FAILS, listing every remaining mention (about 100 lines). That list is the work of Step 5.

- [ ] **Step 5: Replace every mention with the fictional business**

Apply this map across `apps/`, `packages/`, `infra/`, `scripts/` (not `docs/`):

| Was | Becomes |
|---|---|
| `Nupuur Patil` | `Maya Kapoor` |
| `Nupuur Coaching` | `Brightpath Studio` |
| `nupuur.test`, `nupuur.com`, `nupuur.example.com` | `brightpath.test` (`.env.example`: `LUME_PUBLIC_HOST=demo.lumecrm.in`) |
| `owner@nupuur.test`, `nupuur@nupuur.test` | `maya@brightpath.test` |
| `Tasneem Shaikh` | `Leila Haddad` |
| `tasneem@…` | `leila@brightpath.test` |
| `Tasneem`, `Nupuur` (alone) | `Leila`, `Maya` |

Then by hand:
- `packages/core/src/leads/presets.ts`: the comment above `coaching` becomes `// An industry starter: options and lost reasons are examples the admin edits.`
- `apps/api/src/modules/auth/lockout.ts`: the example becomes `"m•••@example.com"`.
- `apps/web/src/components/setup/SetupWizard.tsx`: `useState<"coaching" | "general">("general")`, and the preset cards list General first (the generic default of the licensing spec §0 rule 4). Update `SetupWizard.test.tsx` expectations that assumed coaching first.
- `apps/web/src/app/design/Showcase.tsx`: fictional names.
- `apps/web/e2e/fixtures.ts`: `PEOPLE.owner`, `PEOPLE.admin` and the business name per the map; `seed.setup.ts` and every spec that reads `PEOPLE.*.name` follow automatically.

Re-run `node scripts/check-client-names.mjs` until it prints `check-client-names: clean`.

- [ ] **Step 6: Run everything that the renames touch**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run'` — Expected: all pass.
Run the full e2e with snapshot updates, since names appear in screenshots and aria snapshots:
`scripts/dev.sh run bash -c 'cd apps/web && pnpm exec playwright test --update-snapshots=changed'`
Expected: all pass. Fetch the rewritten baselines with `scripts/dev.sh fetch …`, **open every changed image and aria file**, and confirm the only differences are the names (and General as the setup default). Restore any baseline that changed for another reason and investigate it.

- [ ] **Step 7: Gate, commit, push**

```bash
bash "$G/gate.sh" > "$G/gate.log" 2>&1; tail -1 "$G/gate.log"   # lint now includes the name check
git add -A apps packages infra scripts package.json && git commit -m "chore: a client-neutral codebase — fictional fixtures, General by default, and a CI check for client names" && git push origin main
```

(`docs/runbooks/screenshots-*` still show the old names; they're regenerated by Task 15's live acceptance.)

---

### Task 1: Reading the file (`readCsv`)

**Files:**
- Create: `packages/core/src/intake/limits.ts`, `packages/core/src/intake/read.ts`, `packages/core/src/intake/read.test.ts`, `packages/core/src/intake/index.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./intake";` — the engine is server-only, so Papa Parse never reaches the browser bundle), `packages/core/src/shared.ts` (add `export { INTAKE_LIMITS } from "./intake/limits";` — the only intake value the web needs), `packages/core/package.json` (Papa Parse, through `scripts/dev.sh add`)

**Interfaces:**
- Produces:
  ```ts
  export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
  export type Delimiter = "," | ";" | "\t" | "|";
  export type FileRefusal = { ok: false; code: "FILE_EMPTY" | "FILE_TOO_BIG" | "TOO_MANY_ROWS" | "TOO_MANY_COLUMNS" | "NOT_CSV_EXCEL" | "NOT_TEXT"; message: string };
  export type FileWarning = { code: "ENCODING_GUESSED" | "RAGGED_ROWS"; message: string };
  export type ReadCsv = {
    ok: true; encoding: Encoding; delimiter: Delimiter; headerRow: number; // 1-based record number
    headers: string[]; rows: string[][]; rowNumbers: number[];              // rowNumbers[i]: 1-based record number of rows[i]
    fileWarnings: FileWarning[];
  };
  // limits.ts: export const INTAKE_LIMITS = { bytes: 10_485_760, rows: 20_000, columns: 200, cellChars: 10_000, headerSearch: 10, previewRows: 20, batch: 200 } as const;
  export function readCsv(bytes: Uint8Array, opts?: { fileName?: string; encoding?: Encoding; delimiter?: Delimiter; headerRow?: number }): ReadCsv | FileRefusal;
  export function columnLetter(index: number): string; // 0 → "A", 26 → "AA"
  ```

- [ ] **Step 1: Add Papa Parse to core**

Run: `scripts/dev.sh add papaparse@^5.5.3 --filter @lume/core && scripts/dev.sh add -D @types/papaparse@^5.3.16 --filter @lume/core`
Expected: `packages/core/package.json` and `pnpm-lock.yaml` updated locally.

- [ ] **Step 2: Write the failing tests** (`packages/core/src/intake/read.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { INTAKE_LIMITS } from "./limits";
import { columnLetter, readCsv } from "./read";

const utf8 = (s: string) => new TextEncoder().encode(s);
const ok = (r: ReturnType<typeof readCsv>) => {
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  return r;
};

describe("readCsv: encodings", () => {
  it("reads UTF-8, with or without a BOM", () => {
    const r = ok(readCsv(utf8("﻿Name,Phone\nAïsha,0501234567\n")));
    expect(r.encoding).toBe("utf-8");
    expect(r.headers).toEqual(["Name", "Phone"]);
    expect(r.rows).toEqual([["Aïsha", "0501234567"]]);
  });

  it("reads UTF-16 LE and BE from their BOMs (Excel's 'Unicode text')", () => {
    const le = Buffer.from("﻿Name\tCity\nZoë\tDubai\n", "utf16le");
    const r = ok(readCsv(new Uint8Array(le)));
    expect(r.encoding).toBe("utf-16le");
    expect(r.delimiter).toBe("\t");
    expect(r.rows[0]).toEqual(["Zoë", "Dubai"]);
    const be = Buffer.from(le).swap16();
    expect(ok(readCsv(new Uint8Array(be))).encoding).toBe("utf-16be");
  });

  it("falls back to Windows-1252 with a warning when the bytes aren't UTF-8", () => {
    const bytes = new Uint8Array([...utf8("Name\nCaf"), 0xe9, ...utf8("\n")]);
    const r = ok(readCsv(bytes));
    expect(r.encoding).toBe("windows-1252");
    expect(r.rows[0]).toEqual(["Café"]);
    expect(r.fileWarnings.map((w) => w.code)).toContain("ENCODING_GUESSED");
  });

  it("obeys an encoding override", () => {
    const bytes = new Uint8Array([...utf8("Name\nCaf"), 0xe9, ...utf8("\n")]);
    const r = ok(readCsv(bytes, { encoding: "windows-1252" }));
    expect(r.fileWarnings).toEqual([]);
  });
});

describe("readCsv: delimiters and quoting", () => {
  it.each([
    [",", "Name,Phone,City\nA,1,X\nB,2,Y\n"],
    [";", "Name;Amount;Date\nA;1.234,50;04.03.2026\nB;99,00;05.03.2026\n"],
    ["\t", "Name\tPhone\nA\t1\n"],
    ["|", "Name|Phone\nA|1\nB|2\n"],
  ])("detects %j", (d, text) => {
    expect(ok(readCsv(utf8(text))).delimiter).toBe(d);
  });

  it("keeps commas, quotes and line breaks inside quoted cells, and every line ending", () => {
    const r = ok(readCsv(utf8('Name,Note\r\n"Khan, Aisha","Said ""call me""\nafter 6"\rB,x\n')));
    expect(r.rows).toEqual([
      ["Khan, Aisha", 'Said "call me"\nafter 6'],
      ["B", "x"],
    ]);
  });

  it("treats a one-column file as comma-delimited", () => {
    expect(ok(readCsv(utf8("Name\nA\nB\n"))).delimiter).toBe(",");
  });

  it("obeys a delimiter override", () => {
    const r = ok(readCsv(utf8("a;b,c\n1;2,3\n"), { delimiter: ";" }));
    expect(r.headers).toEqual(["a", "b,c"]);
  });
});

describe("readCsv: the header row", () => {
  it("skips a title line and blank lines above the real header", () => {
    const r = ok(readCsv(utf8("Leads export — March\n\nName,Phone,Email\nA,1,a@x.com\n")));
    expect(r.headerRow).toBe(3);
    expect(r.headers).toEqual(["Name", "Phone", "Email"]);
    expect(r.rowNumbers).toEqual([4]);
  });

  it("uses a chosen header row", () => {
    const r = ok(readCsv(utf8("x,y\nName,Phone\nA,1\n"), { headerRow: 2 }));
    expect(r.headers).toEqual(["Name", "Phone"]);
  });

  it("names blank headers by column letter and numbers repeated ones", () => {
    const r = ok(readCsv(utf8("Phone,,Phone, Phone \n1,2,3,4\n")));
    expect(r.headers).toEqual(["Phone", "Column B", "Phone (2)", "Phone (3)"]);
  });
});

describe("readCsv: rows", () => {
  it("drops trailing empty rows, pads short rows and warns about long ones", () => {
    const r = ok(readCsv(utf8("A,B,C\n1,2\n1,2,3,4\n,,\n\n")));
    expect(r.rows).toEqual([
      ["1", "2", ""],
      ["1", "2", "3", "4"],
    ]);
    expect(r.fileWarnings.map((w) => w.code)).toContain("RAGGED_ROWS");
  });

  it("keeps an empty row in the middle (it's reported as an empty row later)", () => {
    const r = ok(readCsv(utf8("A,B\n1,2\n,\n3,4\n")));
    expect(r.rows).toHaveLength(3);
    expect(r.rowNumbers).toEqual([2, 3, 4]);
  });
});

describe("readCsv: refusals", () => {
  it.each([
    ["an empty file", "", "FILE_EMPTY"],
    ["whitespace only", " \n \n", "FILE_EMPTY"],
    ["a header with no rows", "Name,Phone\n\n", "FILE_EMPTY"],
  ])("refuses %s", (_what, text, code) => {
    expect(readCsv(utf8(text))).toMatchObject({ ok: false, code });
  });

  it("refuses Excel files by content or name, saying how to save as CSV", () => {
    const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    expect(readCsv(xlsx)).toMatchObject({ ok: false, code: "NOT_CSV_EXCEL" });
    expect(readCsv(utf8("a,b\n1,2"), { fileName: "leads.XLSX" })).toMatchObject({ ok: false, code: "NOT_CSV_EXCEL" });
    const r = readCsv(xlsx);
    expect(!r.ok && r.message).toMatch(/Save as → CSV UTF-8/);
  });

  it("refuses binary content", () => {
    expect(readCsv(new Uint8Array([0x00, 0x01, 0x02, 0x41, 0x00]))).toMatchObject({ ok: false, code: "NOT_TEXT" });
  });

  it("refuses too many columns, rows or bytes", () => {
    const wide = `${Array.from({ length: 201 }, (_, i) => `c${i}`).join(",")}\n${"1,".repeat(200)}1\n`;
    expect(readCsv(utf8(wide))).toMatchObject({ ok: false, code: "TOO_MANY_COLUMNS" });
    const tall = `Name\n${"x\n".repeat(INTAKE_LIMITS.rows + 1)}`;
    expect(readCsv(utf8(tall))).toMatchObject({ ok: false, code: "TOO_MANY_ROWS" });
    expect(readCsv(new Uint8Array(INTAKE_LIMITS.bytes + 1).fill(0x41))).toMatchObject({ ok: false, code: "FILE_TOO_BIG" });
  });
});

describe("columnLetter", () => {
  it.each([
    [0, "A"],
    [25, "Z"],
    [26, "AA"],
    [701, "ZZ"],
    [702, "AAA"],
  ])("%i → %s", (i, l) => expect(columnLetter(i)).toBe(l));
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core/src/intake/read.test.ts'`
Expected: FAIL — `Failed to resolve import "./read"`.

- [ ] **Step 4: Implement** (`packages/core/src/intake/read.ts`)

```ts
import Papa from "papaparse";

export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
export type Delimiter = "," | ";" | "\t" | "|";
export type FileRefusal = {
  ok: false;
  code: "FILE_EMPTY" | "FILE_TOO_BIG" | "TOO_MANY_ROWS" | "TOO_MANY_COLUMNS" | "NOT_CSV_EXCEL" | "NOT_TEXT";
  message: string;
};
export type FileWarning = { code: "ENCODING_GUESSED" | "RAGGED_ROWS"; message: string };
export type ReadCsv = {
  ok: true;
  encoding: Encoding;
  delimiter: Delimiter;
  headerRow: number;
  headers: string[];
  rows: string[][];
  rowNumbers: number[];
  fileWarnings: FileWarning[];
};

import { INTAKE_LIMITS } from "./limits";

const DELIMITERS: Delimiter[] = [",", ";", "\t", "|"];
const refuse = (code: FileRefusal["code"], message: string): FileRefusal => ({ ok: false, code, message });

export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function isExcel(bytes: Uint8Array, fileName?: string): boolean {
  if (fileName && /\.(xlsx|xlsm|xls)$/i.test(fileName)) return true;
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  return zip || ole;
}

function decode(bytes: Uint8Array, forced?: Encoding): { text: string; encoding: Encoding; guessed: boolean } {
  const bom8 = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const bomLE = bytes[0] === 0xff && bytes[1] === 0xfe;
  const bomBE = bytes[0] === 0xfe && bytes[1] === 0xff;
  const pick = (enc: Encoding, from: number) => new TextDecoder(enc === "utf-16be" ? "utf-16be" : enc).decode(bytes.subarray(from));
  if (forced) {
    const skip = forced === "utf-8" && bom8 ? 3 : forced !== "utf-8" && forced !== "windows-1252" && (bomLE || bomBE) ? 2 : 0;
    return { text: pick(forced, skip), encoding: forced, guessed: false };
  }
  if (bom8) return { text: pick("utf-8", 3), encoding: "utf-8", guessed: false };
  if (bomLE) return { text: pick("utf-16le", 2), encoding: "utf-16le", guessed: false };
  if (bomBE) return { text: pick("utf-16be", 2), encoding: "utf-16be", guessed: false };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8", guessed: false };
  } catch {
    return { text: pick("windows-1252", 0), encoding: "windows-1252", guessed: true };
  }
}

const parse = (text: string, delimiter: Delimiter, preview = 0): string[][] =>
  Papa.parse<string[]>(text, { delimiter, quoteChar: '"', skipEmptyLines: false, preview }).data;

/** The delimiter whose rows agree most on a column count (over the first 50 lines, outside quotes). */
function detectDelimiter(text: string): Delimiter {
  let best: { d: Delimiter; score: number } = { d: ",", score: 0 };
  for (const d of DELIMITERS) {
    const counts = parse(text, d, 50)
      .filter((r) => r.some((c) => c.trim() !== ""))
      .map((r) => r.length);
    if (!counts.length) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [mode, hits] = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    if (mode < 2) continue;
    if (hits > best.score) best = { d, score: hits }; // ties keep the earlier (preferred) delimiter
  }
  return best.d;
}

const blank = (r: string[]) => r.every((c) => c.trim() === "");

/** The first record (among the first 10) that has the file's usual width and at least two filled cells. */
function detectHeader(records: string[][]): number {
  const widths = records.filter((r) => !blank(r)).map((r) => r.length);
  const freq = new Map<number, number>();
  for (const w of widths) freq.set(w, (freq.get(w) ?? 0) + 1);
  const mode = [...freq].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 1;
  const limit = Math.min(records.length, INTAKE_LIMITS.headerSearch);
  for (let i = 0; i < limit; i++) {
    const r = records[i]!;
    const filled = r.filter((c) => c.trim() !== "").length;
    if (r.length === mode && (filled >= 2 || mode === 1) && filled > 0) return i;
  }
  for (let i = 0; i < limit; i++) if (!blank(records[i]!)) return i;
  return 0;
}

function nameHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `Column ${columnLetter(i)}`;
    const key = base.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** Spec §5.1: bytes → a table, or the one reason LUME can't read it. */
export function readCsv(
  bytes: Uint8Array,
  opts: { fileName?: string; encoding?: Encoding; delimiter?: Delimiter; headerRow?: number } = {},
): ReadCsv | FileRefusal {
  if (bytes.length > INTAKE_LIMITS.bytes) return refuse("FILE_TOO_BIG", "This file is over 10 MB. Split it into smaller files.");
  if (isExcel(bytes, opts.fileName))
    return refuse("NOT_CSV_EXCEL", "This is an Excel file. Save it as CSV (File → Save as → CSV UTF-8) and upload that.");
  const { text, encoding, guessed } = decode(bytes, opts.encoding);
  if (text.includes("\u0000")) return refuse("NOT_TEXT", "LUME can't read this file as text. Upload a CSV file.");
  if (!text.trim()) return refuse("FILE_EMPTY", "This file is empty.");

  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const records = parse(text, delimiter);
  const headerIndex = opts.headerRow ? Math.min(opts.headerRow, records.length) - 1 : detectHeader(records);
  const headerCells = records[headerIndex] ?? [];
  if (headerCells.length > INTAKE_LIMITS.columns)
    return refuse("TOO_MANY_COLUMNS", `This file has ${headerCells.length} columns; LUME reads up to 200.`);

  let body = records.slice(headerIndex + 1).map((r, i) => ({ cells: r, number: headerIndex + i + 2 }));
  while (body.length && blank(body[body.length - 1]!.cells)) body.pop();
  if (!body.length) return refuse("FILE_EMPTY", "LUME found a header but no rows under it.");
  if (body.length > INTAKE_LIMITS.rows)
    return refuse("TOO_MANY_ROWS", `This file has ${body.length.toLocaleString("en")} rows; LUME imports up to 20,000 at a time.`);

  const width = headerCells.length;
  let ragged = 0;
  body = body.map((b) => {
    if (b.cells.length !== width) ragged++;
    return b.cells.length < width ? { ...b, cells: [...b.cells, ...Array(width - b.cells.length).fill("")] } : b;
  });

  const fileWarnings: FileWarning[] = [];
  if (guessed)
    fileWarnings.push({ code: "ENCODING_GUESSED", message: "Some characters may be wrong — check the accents in the preview." });
  if (ragged)
    fileWarnings.push({ code: "RAGGED_ROWS", message: `${ragged} rows have a different number of cells from the header.` });

  return {
    ok: true,
    encoding,
    delimiter,
    headerRow: headerIndex + 1,
    headers: nameHeaders(headerCells),
    rows: body.map((b) => b.cells),
    rowNumbers: body.map((b) => b.number),
    fileWarnings,
  };
}
```

`packages/core/src/intake/limits.ts` (no imports, so the browser can have it):
```ts
/** Spec §5.1. One place for every intake limit, so the API, the job and the screens agree. */
export const INTAKE_LIMITS = {
  bytes: 10_485_760,
  rows: 20_000,
  columns: 200,
  cellChars: 10_000,
  headerSearch: 10,
  previewRows: 20,
  batch: 200,
} as const;
```

`packages/core/src/intake/index.ts`:
```ts
export * from "./limits";
export * from "./read";
```
`packages/core/src/index.ts` gains `export * from "./intake";`, and `packages/core/src/shared.ts` gains `export { INTAKE_LIMITS } from "./intake/limits";`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core/src/intake/read.test.ts'`
Expected: PASS (every test). If the one-column test picks another delimiter, check `detectDelimiter` skips modes below 2.

- [ ] **Step 6: Gate, commit, push**

```bash
bash "$G/gate.sh" > "$G/gate.log" 2>&1; tail -1 "$G/gate.log"   # GATE_OK
git add packages/core pnpm-lock.yaml && git commit -m "feat(core): read a CSV — encodings, delimiters, a header below a title, and a clear refusal" && git push origin main
```

---

### Task 2: Value parsers (`values.ts`)

**Files:**
- Create: `packages/core/src/intake/values.ts`, `packages/core/src/intake/values.test.ts`
- Modify: `packages/core/src/intake/index.ts` (`export * from "./values";`)

**Interfaces:**
- Produces:
  ```ts
  export type DateOrder = "DMY" | "MDY" | "YMD";
  export type Parsed<T> = { ok: true; value: T; warning?: ValueIssue } | { ok: false; issue: ValueIssue };
  export type ValueIssue = { code: string; message: string };
  export function detectDateOrder(values: string[]): DateOrder | "conflict" | "ambiguous";
  export function defaultDateOrder(country: string | null): DateOrder;          // US, PH, BZ, FM, MH, PW → MDY; else DMY
  export function parseDate(raw: string, order: DateOrder, ctx: { today: string; timezone: string }): Parsed<{ date: string; instant: string }>;
  export function detectDecimalMark(values: string[], fallback: "." | ","): "." | ",";
  export function defaultDecimalMark(country: string | null): "." | ",";
  export function parseNumber(raw: string, decimal: "." | ","): Parsed<number>;
  export function parseMoney(raw: string, decimal: "." | ",", currency: string): Parsed<number>;
  export function parseBoolean(raw: string): boolean | null;
  export function readEmail(raw: string): string | null;
  export function readInstagram(raw: string): string | null;
  export function readUrl(raw: string): string | null;
  export function splitPhones(raw: string): string[];
  export function isScientific(raw: string): boolean;
  export function fold(s: string): string; // lower-case, accents removed, spaces collapsed — for matching labels
  export function startOfDayUtc(date: string, timezone: string): Date; // midnight of that calendar date in the business timezone
  ```

- [ ] **Step 1: Write the failing tests** (`packages/core/src/intake/values.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import {
  defaultDateOrder,
  defaultDecimalMark,
  detectDateOrder,
  detectDecimalMark,
  fold,
  isScientific,
  parseBoolean,
  parseDate,
  parseMoney,
  parseNumber,
  readEmail,
  readInstagram,
  readUrl,
  splitPhones,
  startOfDayUtc,
} from "./values";

const ctx = { today: "2026-09-27", timezone: "Asia/Dubai" };
const val = <T,>(r: { ok: boolean; value?: T }) => (r.ok ? r.value : undefined);
const code = (r: { ok: boolean; issue?: { code: string } }) => (r.ok ? undefined : r.issue!.code);

describe("dates: the order of day and month, per column", () => {
  it.each([
    [["13/03/2026", "04/03/2026"], "DMY"],
    [["03/13/2026", "03/04/2026"], "MDY"],
    [["2026-03-04", "2026/03/05"], "YMD"],
    [["03/04/2026", "05/06/2026"], "ambiguous"],
    [["13/03/2026", "03/13/2026"], "conflict"],
    [["4 Mar 2026", "", "45123"], "ambiguous"],
  ])("%j → %s", (values, order) => expect(detectDateOrder(values)).toBe(order));

  it("defaults from the business country", () => {
    expect(defaultDateOrder("US")).toBe("MDY");
    expect(defaultDateOrder("AE")).toBe("DMY");
    expect(defaultDateOrder(null)).toBe("DMY");
  });
});

describe("parseDate", () => {
  it.each([
    ["04/03/2026", "DMY", "2026-03-04"],
    ["03/04/2026", "MDY", "2026-03-04"],
    ["04.03.26", "DMY", "2026-03-04"],
    ["4-3-2026", "DMY", "2026-03-04"],
    ["2026-03-04", "DMY", "2026-03-04"],
    ["4 Mar 2026", "MDY", "2026-03-04"],
    ["March 4, 2026", "DMY", "2026-03-04"],
    ["45720", "DMY", "2025-03-04"],
    ["04/03/99", "DMY", "1999-03-04"],
  ] as const)("%s (%s) → %s", (raw, order, date) => {
    expect(val(parseDate(raw, order, ctx))?.date).toBe(date);
  });

  it("reads a time in the business timezone, and converts an explicit offset", () => {
    expect(val(parseDate("2026-03-04 10:30", "YMD", ctx))?.instant).toBe("2026-03-04T06:30:00.000Z");
    expect(val(parseDate("2026-03-04T23:30:00Z", "YMD", ctx))).toEqual({
      date: "2026-03-05", // 03:30 on the 5th in Dubai
      instant: "2026-03-04T23:30:00.000Z",
    });
  });

  it.each([
    ["31/02/2026", "DATE_IMPOSSIBLE"],
    ["13/13/2026", "DATE_IMPOSSIBLE"],
    ["28/09/2026", "DATE_FUTURE"],
    ["01/01/1980", "DATE_TOO_OLD"],
    ["next tuesday", "DATE_UNREADABLE"],
  ])("refuses %s (%s)", (raw, c) => expect(code(parseDate(raw, "DMY", ctx))).toBe(c));
});

describe("numbers and money", () => {
  it("decides the decimal mark per column", () => {
    expect(detectDecimalMark(["1.234,50", "99,00"], ".")).toBe(",");
    expect(detectDecimalMark(["1,234.50", "99.00"], ",")).toBe(".");
    expect(detectDecimalMark(["1,234,567"], ",")).toBe(".");
    expect(detectDecimalMark(["4,5"], ".")).toBe(",");
    expect(detectDecimalMark(["1,234", "5,678"], ".")).toBe("."); // only ambiguous values: the business default
    expect(defaultDecimalMark("DE")).toBe(",");
    expect(defaultDecimalMark("AE")).toBe(".");
  });

  it.each([
    ["1,234.5", ".", 1234.5],
    ["1.234,5", ",", 1234.5],
    ["1 234,5", ",", 1234.5],
    ["1'234.50", ".", 1234.5],
    ["4500", ".", 4500],
    ["12%", ".", 12],
    ["-3", ".", -3],
  ] as const)("number %s (%s) → %d", (raw, mark, n) => expect(val(parseNumber(raw, mark))).toBe(n));

  it("refuses a number that isn't one", () => {
    expect(code(parseNumber("12 apples", "."))).toBe("NOT_A_NUMBER");
    expect(code(parseNumber("1,23,4", "."))).toBe("NOT_A_NUMBER");
  });

  it("reads money in the business currency, before or after, code or symbol", () => {
    expect(val(parseMoney("AED 4,500", ".", "AED"))).toBe(4500);
    expect(val(parseMoney("4,500 AED", ".", "AED"))).toBe(4500);
    expect(val(parseMoney("د.إ 4,500", ".", "AED"))).toBe(4500);
    expect(val(parseMoney("₹1,20,000", ".", "INR"))).toBe(120000); // Indian grouping
  });

  it("refuses another currency, negatives, and rounds past two decimals with a warning", () => {
    const usd = parseMoney("$1,200", ".", "AED");
    expect(code(usd)).toBe("FOREIGN_CURRENCY");
    expect(!usd.ok && usd.issue.message).toBe("This amount is in USD; LUME works in AED — convert it before importing.");
    expect(code(parseMoney("-50", ".", "AED"))).toBe("NEGATIVE_AMOUNT");
    const r = parseMoney("10.005", ".", "AED");
    expect(val(r)).toBe(10.01);
    expect(r.ok && r.warning?.code).toBe("AMOUNT_ROUNDED");
  });
});

describe("booleans, contacts and links", () => {
  it.each([
    ["Yes", true],
    ["y", true],
    ["TRUE", true],
    ["1", true],
    ["✓", true],
    ["x", true],
    ["No", false],
    ["n", false],
    ["false", false],
    ["0", false],
    ["✗", false],
    ["maybe", null],
  ] as const)("%s → %s", (raw, b) => expect(parseBoolean(raw)).toBe(b));

  it("reads emails", () => {
    expect(readEmail(" Aisha@Example.COM ")).toBe("aisha@example.com");
    expect(readEmail("mailto:a@b.co")).toBe("a@b.co");
    expect(readEmail("not an email")).toBeNull();
  });

  it("reads Instagram handles from @names and profile links", () => {
    expect(readInstagram("@Aisha.K")).toBe("aisha.k");
    expect(readInstagram("https://www.instagram.com/aisha_k/?hl=en")).toBe("aisha_k");
    expect(readInstagram("instagram.com/aisha_k")).toBe("aisha_k");
    expect(readInstagram("not a handle!")).toBeNull();
    expect(readInstagram("a".repeat(31))).toBeNull();
  });

  it("reads links, adding https when missing", () => {
    expect(readUrl("brightpath.test/coaching")).toBe("https://brightpath.test/coaching");
    expect(readUrl("http://x.test/a")).toBe("http://x.test/a");
    expect(readUrl("not a link")).toBeNull();
  });

  it("splits several numbers in one cell, and spots Excel's scientific notation", () => {
    expect(splitPhones("050 111 2222 / 055 333 4444")).toEqual(["050 111 2222", "055 333 4444"]);
    expect(splitPhones("0501112222 or 0553334444")).toEqual(["0501112222", "0553334444"]);
    expect(splitPhones("+971 50 111 2222")).toEqual(["+971 50 111 2222"]);
    expect(isScientific("9.71501E+11")).toBe(true);
    expect(isScientific("9,71501E+11")).toBe(true);
    expect(isScientific("971501234567")).toBe(false);
  });

  it("finds midnight of a business-day as an instant", () => {
    expect(startOfDayUtc("2026-03-04", "Asia/Dubai").toISOString()).toBe("2026-03-03T20:00:00.000Z");
  });

  it("folds labels for matching", () => {
    expect(fold("  Café   Crème ")).toBe("cafe creme");
  });
});

describe("Review Focus 1: a semicolon CSV with comma decimals", () => {
  it("reads 1.234,50 as one thousand two hundred and thirty-four and a half", () => {
    const mark = detectDecimalMark(["1.234,50", "99,00", "12"], ".");
    expect(val(parseMoney("1.234,50", mark, "AED"))).toBe(1234.5);
    expect(val(parseDate("04.03.2026", detectDateOrder(["04.03.2026", "25.03.2026"]) as "DMY", ctx))?.date).toBe("2026-03-04");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core/src/intake/values.test.ts'`
Expected: FAIL — `Failed to resolve import "./values"`.

- [ ] **Step 3: Implement** (`packages/core/src/intake/values.ts`)

```ts
export type DateOrder = "DMY" | "MDY" | "YMD";
export type ValueIssue = { code: string; message: string };
export type Parsed<T> = { ok: true; value: T; warning?: ValueIssue } | { ok: false; issue: ValueIssue };

const okv = <T,>(value: T, warning?: ValueIssue): Parsed<T> => (warning ? { ok: true, value, warning } : { ok: true, value });
const bad = (code: string, message: string): Parsed<never> => ({ ok: false, issue: { code, message } });

export const fold = (s: string): string =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// ── dates ─────────────────────────────────────────────────────────────────────
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NUMERIC = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const MDY_COUNTRIES = new Set(["US", "PH", "BZ", "FM", "MH", "PW"]);

export const defaultDateOrder = (country: string | null): DateOrder =>
  country && MDY_COUNTRIES.has(country) ? "MDY" : "DMY";

/** Spec §6.7: any first part over 12 means DMY, any second part over 12 means MDY; both is a conflict. */
export function detectDateOrder(values: string[]): DateOrder | "conflict" | "ambiguous" {
  let dmy = false;
  let mdy = false;
  let ymd = false;
  for (const raw of values) {
    const v = raw.trim();
    if (!v || ISO.test(v)) {
      if (ISO.test(v)) ymd = true;
      continue;
    }
    const m = NUMERIC.exec(v);
    if (!m) continue;
    if (m[1]!.length === 4) {
      ymd = true;
      continue;
    }
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && a <= 31) dmy = true;
    if (b > 12 && b <= 31) mdy = true;
  }
  if (dmy && mdy) return "conflict";
  if (dmy) return "DMY";
  if (mdy) return "MDY";
  if (ymd) return "YMD";
  return "ambiguous";
}

const pad = (n: number) => String(n).padStart(2, "0");
const validYmd = (y: number, m: number, d: number) => {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const fullYear = (y: number, today: string) => {
  if (y >= 100) return y;
  const yy = Number(today.slice(2, 4));
  return y <= yy + 1 ? 2000 + y : 1900 + y;
};

/** Minutes east of UTC for `tz` at the instant `utcMs`. */
function offsetMinutes(utcMs: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((asUtc - utcMs) / 60_000);
}
/** A wall-clock time in `tz` → the UTC instant (two passes settle DST edges). */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - offsetMinutes(guess, tz) * 60_000;
  return guess - offsetMinutes(first, tz) * 60_000;
}
/** Midnight at the start of `date` (YYYY-MM-DD) in `tz`, as an instant. */
export function startOfDayUtc(date: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(zonedToUtc(y, m, d, 0, 0, 0, tz));
}

/** The calendar date of an instant in `tz`. */
function dateIn(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(utcMs));
}

function finish(y: number, m: number, d: number, time: [number, number, number] | null, offset: string | null, ctx: { today: string; timezone: string }): Parsed<{ date: string; instant: string }> {
  if (!validYmd(y, m, d)) return bad("DATE_IMPOSSIBLE", "This date doesn't exist.");
  const [h, mi, s] = time ?? [0, 0, 0];
  if (h > 23 || mi > 59 || s > 59) return bad("DATE_IMPOSSIBLE", "This time doesn't exist.");
  let instant: number;
  if (offset) {
    const sign = offset === "Z" ? 0 : offset.startsWith("-") ? -1 : 1;
    const [oh, om] = offset === "Z" ? [0, 0] : [Number(offset.slice(1, 3)), Number(offset.slice(-2))];
    instant = Date.UTC(y, m - 1, d, h, mi, s) - sign * (oh * 60 + om) * 60_000;
  } else instant = zonedToUtc(y, m, d, h, mi, s, ctx.timezone);
  const date = offset ? dateIn(instant, ctx.timezone) : `${y}-${pad(m)}-${pad(d)}`;
  if (date > ctx.today) return bad("DATE_FUTURE", "Date is in the future — check the day/month order.");
  if (date < "1990-01-01") return bad("DATE_TOO_OLD", "Date looks wrong (before 1990).");
  return okv({ date, instant: new Date(instant).toISOString() });
}

/** Spec §6.7. */
export function parseDate(raw: string, order: DateOrder, ctx: { today: string; timezone: string }): Parsed<{ date: string; instant: string }> {
  const v = raw.trim();
  const iso = ISO.exec(v);
  if (iso) {
    const t = iso[4] ? ([Number(iso[4]), Number(iso[5]), Number(iso[6] ?? 0)] as [number, number, number]) : null;
    return finish(Number(iso[1]), Number(iso[2]), Number(iso[3]), t, iso[7] ?? null, ctx);
  }
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const serial = Number(v);
    if (serial < 20000 || serial > 80000) return bad("DATE_UNREADABLE", "LUME can't read this as a date.");
    const ms = Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000);
    const dt = new Date(ms);
    const hasTime = serial % 1 !== 0;
    return finish(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), hasTime ? [dt.getUTCHours(), dt.getUTCMinutes(), dt.getUTCSeconds()] : null, null, ctx);
  }
  const n = NUMERIC.exec(v);
  if (n) {
    const [a, b, c] = [Number(n[1]), Number(n[2]), Number(n[3])];
    const t = n[4] ? ([Number(n[4]), Number(n[5]), Number(n[6] ?? 0)] as [number, number, number]) : null;
    if (n[1]!.length === 4) return finish(a, b, c, t, null, ctx);
    const y = fullYear(c, ctx.today);
    return order === "MDY" ? finish(y, a, b, t, null, ctx) : finish(y, b, a, t, null, ctx);
  }
  const words = /^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{2,4})$/i.exec(v) ?? null;
  const wordsUs = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{2,4})$/i.exec(v) ?? null;
  const pick = words
    ? { d: Number(words[1]), mon: words[2]!, y: Number(words[3]) }
    : wordsUs
      ? { d: Number(wordsUs[2]), mon: wordsUs[1]!, y: Number(wordsUs[3]) }
      : null;
  if (pick) {
    const m = MONTHS.indexOf(pick.mon.slice(0, 3).toLowerCase()) + 1;
    if (m > 0) return finish(fullYear(pick.y, ctx.today), m, pick.d, null, null, ctx);
  }
  return bad("DATE_UNREADABLE", "LUME can't read this as a date.");
}

// ── numbers and money ─────────────────────────────────────────────────────────
const COMMA_DECIMAL = new Set(["DE", "FR", "ES", "IT", "NL", "BE", "PT", "BR", "AR", "CL", "CO", "ID", "TR", "RU", "UA", "PL", "SE", "NO", "DK", "FI", "AT", "CZ", "GR", "RO", "HU", "VN", "ZA"]);
export const defaultDecimalMark = (country: string | null): "." | "," => (country && COMMA_DECIMAL.has(country) ? "," : ".");

const strip = (s: string) => s.replace(/[\s   ']/g, "");

/** What one value says about its decimal mark, if anything. */
function markOf(raw: string): "." | "," | null {
  const s = strip(raw).replace(/^[^\d-]+|[^\d%]+$/g, "");
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  if (dots && commas) return s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
  if (dots > 1) return ",";
  if (commas > 1) return ".";
  const one = dots ? "." : commas ? "," : null;
  if (!one) return null;
  const after = s.length - s.lastIndexOf(one) - 1;
  return after === 3 ? null : one; // exactly three digits after one separator: can't tell
}

/** Spec §6.8: the column decides; values that can't tell follow the business's convention. */
export function detectDecimalMark(values: string[], fallback: "." | ","): "." | "," {
  let dot = 0;
  let comma = 0;
  for (const v of values) {
    const m = markOf(v);
    if (m === ".") dot++;
    if (m === ",") comma++;
  }
  if (!dot && !comma) return fallback;
  return comma > dot ? "," : ".";
}

export function parseNumber(raw: string, decimal: "." | ","): Parsed<number> {
  let s = strip(raw).replace(/%$/, "");
  const thousands = decimal === "." ? "," : ".";
  if (!/^-?[\d.,]+$/.test(s)) return bad("NOT_A_NUMBER", `“${raw.trim()}” isn't a number.`);
  const [int, frac, ...more] = s.split(decimal);
  if (more.length) return bad("NOT_A_NUMBER", `“${raw.trim()}” isn't a number.`);
  const groups = int!.replace(/^-/, "").split(thousands);
  // Western groups of three, or Indian lakh grouping (2s then a final 3): 1,20,000.
  const western = groups.slice(1).every((g) => g.length === 3);
  const indian = groups.length > 2 && groups.slice(1, -1).every((g) => g.length === 2) && groups.at(-1)!.length === 3;
  if (groups.length > 1 && (!(western || indian) || !groups[0])) return bad("NOT_A_NUMBER", `“${raw.trim()}” isn't a number.`);
  s = `${int!.replaceAll(thousands, "")}${frac !== undefined ? `.${frac}` : ""}`;
  const n = Number(s);
  return Number.isFinite(n) ? okv(n) : bad("NOT_A_NUMBER", `“${raw.trim()}” isn't a number.`);
}

const SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY", "₩": "KRW", "₽": "RUB", "₺": "TRY", "₦": "NGN", "₱": "PHP", "د.إ": "AED", "ر.س": "SAR", "﷼": "SAR" };
const CURRENCY_CODES: ReadonlySet<string> = new Set(
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : Object.values(SYMBOLS),
);

export function parseMoney(raw: string, decimal: "." | ",", currency: string): Parsed<number> {
  let s = raw.trim();
  let found: string | null = null;
  for (const [sym, code] of Object.entries(SYMBOLS))
    if (s.includes(sym)) {
      found = code;
      s = s.replace(sym, "");
    }
  const codeMatch = /\b([A-Za-z]{3})\b/.exec(s);
  if (codeMatch && CURRENCY_CODES.has(codeMatch[1]!.toUpperCase())) {
    found = codeMatch[1]!.toUpperCase();
    s = s.replace(codeMatch[0], "");
  }
  if (found && found !== currency)
    return bad("FOREIGN_CURRENCY", `This amount is in ${found}; LUME works in ${currency} — convert it before importing.`);
  const n = parseNumber(s, decimal);
  if (!n.ok) return n;
  if (n.value < 0) return bad("NEGATIVE_AMOUNT", "An amount can't be negative.");
  const rounded = Math.round((n.value + Number.EPSILON) * 100) / 100;
  return rounded === n.value ? okv(rounded) : okv(rounded, { code: "AMOUNT_ROUNDED", message: `Rounded ${n.value} to ${rounded}.` });
}

// ── booleans, contacts, links ─────────────────────────────────────────────────
const YES = new Set(["yes", "y", "true", "1", "✓", "✔", "x"]);
const NO = new Set(["no", "n", "false", "0", "✗", "✘"]);
export function parseBoolean(raw: string): boolean | null {
  const v = fold(raw);
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  return null;
}

export function readEmail(raw: string): string | null {
  const v = raw.trim().replace(/^mailto:/i, "").toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254 ? v : null;
}

export function readInstagram(raw: string): string | null {
  let v = raw.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)/i.exec(v);
  if (url) v = url[1]!;
  v = v.replace(/^@/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(v) ? v.toLowerCase() : null;
}

export function readUrl(raw: string): string | null {
  const v = raw.trim();
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    return /\./.test(u.hostname) && !/\s/.test(v) ? u.toString().replace(/\/$/, v.endsWith("/") ? "/" : "") : null;
  } catch {
    return null;
  }
}

export const splitPhones = (raw: string): string[] =>
  raw
    .split(/\s*(?:\/|,|;|\bor\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);

export const isScientific = (raw: string): boolean => /^\d+([.,]\d+)?e\+?\d+$/i.test(raw.trim());
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core/src/intake/values.test.ts'`
Expected: PASS. The two instant assertions depend on `Asia/Dubai` being +04:00 with no DST: `10:30` local → `06:30Z`; `23:30Z` → `03:30` on the 5th.

- [ ] **Step 5: Gate, commit, push**

```bash
bash "$G/gate.sh" > "$G/gate.log" 2>&1; tail -1 "$G/gate.log"
git add packages/core && git commit -m "feat(core): read dates, numbers, money, booleans and contacts the way people type them" && git push origin main
```

---

### Task 3: Mapping, column analysis and `mapRow`

**Files:**
- Create: `packages/core/src/intake/mapping.ts`, `packages/core/src/intake/mapping.test.ts`, `packages/core/src/intake/map-row.ts`, `packages/core/src/intake/map-row.test.ts`, `packages/core/src/intake/test-context.ts` (a test fixture only tests import)
- Modify: `packages/core/src/intake/index.ts` (`export * from "./mapping"; export * from "./map-row";`)

**Interfaces:**
- Consumes (Tasks 1–2): `INTAKE_LIMITS`, `DateOrder`, `parseDate`, `parseNumber`, `parseMoney`, `parseBoolean`, `readEmail`, `readInstagram`, `readUrl`, `splitPhones`, `isScientific`, `fold`, `detectDateOrder`, `detectDecimalMark`, `defaultDateOrder`, `defaultDecimalMark`; from `@lume/core`: `normalizePhone`, `formatPhone`, `type NormalizedPhone`, `type FieldType`.
- Produces:
  ```ts
  export type Transform = { case?: "lower" | "title"; dateOrder?: DateOrder; defaultCountry?: string; valueMap?: Record<string, string | null>; splitOn?: "," | ";" | "|" };
  export type ColumnMap =
    | { column: number; to: "ignore" }
    | { column: number; to: "field"; field: string; transform?: Transform }          // field: a field key, or "tags" | "lost_reason"
    | { column: number; to: "name_part"; part: "first" | "last"; transform?: Transform }
    | { column: number; to: "new_field"; label: string; type: FieldType; transform?: Transform };
  export type Mapping = { columns: ColumnMap[]; createMissingTags: boolean; addOptions?: Record<string, string[]> }; // addOptions: field key → labels to create at Start
  export type OwnerRule = { mode: "unassigned" } | { mode: "user"; userId: string } | { mode: "round_robin"; userIds: string[] };
  export type Rules = {
    matchOn: ("phone" | "email" | "instagram")[]; onMatch: "merge" | "skip" | "duplicate"; reopenClosedTo: string | null;
    pipelineId: string; stageId: string; owner: OwnerRule; defaultCountry: string | null;
    noName: "use_contact" | "error"; unknownOwner: "fallback" | "error"; requiredDefaults: Record<string, unknown>;
  };
  export type IntakeField = { id: string; key: string; label: string; type: FieldType; options: { id: string; label: string; archived?: boolean }[]; isCore: boolean; isRequired: boolean; archived: boolean; access: "edit" | "view" | "hidden" };
  export type MapContext = {
    fields: IntakeField[]; stages: { id: string; name: string; kind: "open" | "won" | "lost" }[];
    people: { id: string; name: string; email: string; active: boolean }[]; tags: { id: string; label: string }[];
    lostReasons: { id: string; label: string }[]; currency: string; country: string | null; today: string; timezone: string;
    importerId: string; canAssign: boolean; canManageFields: boolean; canManageTags: boolean; headerCount: number;
    dateOrders: Record<number, DateOrder>; decimalMarks: Record<number, "." | ",">;
  };
  export type Issue = { column: number | null; code: string; message: string };
  export type LeadDraft = {
    name: string; nameFromContact: boolean; phone: NormalizedPhone; extraPhones: string[];
    email: string | null; instagram: string | null; stageId: string | null; stageKind: "open" | "won" | "lost" | null;
    ownerId: string | null | undefined;    // undefined: use the owner rule
    value: number | null; leadCreatedAt: string | null; lostReasonId: string | null;
    custom: Record<string, unknown>; tagIds: string[];
  };
  export type RowOutcome =
    | { kind: "empty" }
    | { kind: "draft"; draft: LeadDraft; warnings: Issue[] }
    | { kind: "error"; problems: Issue[]; warnings: Issue[] };
  export type ColumnAnalysis = { column: number; dateOrder?: DateOrder | "conflict" | "ambiguous"; decimalMark?: "." | ","; unmatched: { value: string; rows: number }[] };
  export const DEFAULT_RULES: (o: { pipelineId: string; stageId: string; country: string | null }) => Rules;
  export function suggestMapping(headers: string[], fields: IntakeField[], memory?: Mapping | null): Mapping;
  export function validateMapping(m: Mapping, r: Rules, ctx: MapContext): Issue[];
  export function analyzeColumns(rows: string[][], m: Mapping, ctx: MapContext): ColumnAnalysis[];
  export function resolveColumnSettings(analysis: ColumnAnalysis[], m: Mapping, ctx: Pick<MapContext, "country">): { dateOrders: Record<number, DateOrder>; decimalMarks: Record<number, "." | ",">; blocking: Issue[] };
  export function mapRow(cells: string[], m: Mapping, r: Rules, ctx: MapContext): RowOutcome;
  export const MAPPABLE_TARGETS: (fields: IntakeField[]) => { key: string; label: string; group: "Contact" | "Lead" | "Custom" }[];
  ```

- [ ] **Step 1: Write the test context** (`packages/core/src/intake/test-context.ts`)

```ts
import type { IntakeField, MapContext, Mapping, Rules } from "./mapping";

const f = (key: string, label: string, type: IntakeField["type"], extra: Partial<IntakeField> = {}): IntakeField => ({
  id: `f-${key}`, key, label, type, options: [], isCore: false, isRequired: false, archived: false, access: "edit", ...extra,
});

/** A coaching business in Dubai, as the tests see it. Only tests import this file. */
export const testContext = (over: Partial<MapContext> = {}): MapContext => ({
  fields: [
    f("name", "Name", "text", { isCore: true, isRequired: true }),
    f("phone", "Phone", "phone", { isCore: true }),
    f("email", "Email", "email", { isCore: true }),
    f("instagram", "Instagram", "instagram", { isCore: true }),
    f("owner", "Handled by (owner)", "user", { isCore: true }),
    f("stage", "Stage", "select", { isCore: true, isRequired: true }),
    f("source", "Source", "text", { isCore: true }),
    f("value", "Value", "currency", { isCore: true }),
    f("lead_created_at", "Date", "date", { isCore: true }),
    f("struggles", "Struggles", "multi_select", { options: [{ id: "o-conf", label: "Confidence" }, { id: "o-career", label: "Career switch" }] }),
    f("tier", "Tier", "select", { options: [{ id: "o-gold", label: "Gold" }, { id: "o-silver", label: "Silver" }, { id: "o-old", label: "Bronze", archived: true }] }),
    f("paid", "Paid", "boolean"),
    f("budget", "Budget", "currency"),
    f("call_at", "Call at", "datetime"),
    f("website", "Website", "url"),
    f("alt_phone", "Alt phone", "phone"),
    f("coach", "Coach", "user"),
    f("notes", "Notes", "long_text"),
    f("secret", "Secret", "text", { access: "hidden" }),
    f("gone", "Gone", "text", { archived: true }),
  ],
  stages: [
    { id: "s-new", name: "New", kind: "open" },
    { id: "s-booked", name: "Call booked", kind: "open" },
    { id: "s-won", name: "Won", kind: "won" },
    { id: "s-lost", name: "Lost", kind: "lost" },
  ],
  people: [
    { id: "u-riya", name: "Riya Sharma", email: "riya@brightpath.test", active: true },
    { id: "u-sam1", name: "Sam Lee", email: "sam.lee@brightpath.test", active: true },
    { id: "u-sam2", name: "Sam Lee", email: "sam.l@brightpath.test", active: true },
    { id: "u-old", name: "Omar Gone", email: "omar@brightpath.test", active: false },
    { id: "u-me", name: "Maya Kapoor", email: "maya@brightpath.test", active: true },
  ],
  tags: [{ id: "t-hot", label: "Hot" }, { id: "t-vip", label: "VIP" }],
  lostReasons: [{ id: "r-price", label: "Price" }],
  currency: "AED",
  country: "AE",
  today: "2026-09-27",
  timezone: "Asia/Dubai",
  importerId: "u-me",
  canAssign: true,
  canManageFields: true,
  canManageTags: true,
  headerCount: 20,
  dateOrders: {},
  decimalMarks: {},
  ...over,
});

export const testRules = (over: Partial<Rules> = {}): Rules => ({
  matchOn: ["phone", "email", "instagram"],
  onMatch: "merge",
  reopenClosedTo: null,
  pipelineId: "p1",
  stageId: "s-new",
  owner: { mode: "unassigned" },
  defaultCountry: "AE",
  noName: "use_contact",
  unknownOwner: "fallback",
  requiredDefaults: {},
  ...over,
});

/** A mapping from "field key per column" shorthand: ["name", "phone", null, …]. */
export const mapOf = (keys: (string | null)[], createMissingTags = false): Mapping => ({
  columns: keys.map((k, column) => (k === null ? { column, to: "ignore" as const } : { column, to: "field" as const, field: k })),
  createMissingTags,
});
```

- [ ] **Step 2: Write the failing tests** (`packages/core/src/intake/mapping.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, MAPPABLE_TARGETS, suggestMapping, validateMapping, type Mapping } from "./mapping";
import { mapOf, testContext, testRules } from "./test-context";

const ctx = testContext();
const target = (m: Mapping, column: number) => {
  const c = m.columns[column]!;
  return c.to === "field" ? c.field : c.to === "name_part" ? `name_part:${c.part}` : c.to;
};

describe("suggestMapping", () => {
  it("matches common headers, and leaves anything unsure as Ignore", () => {
    const m = suggestMapping(["Full Name", "Mobile No.", "E-mail", "IG", "Timestamp", "Assigned to", "Status", "Favourite colour"], ctx.fields);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => target(m, i))).toEqual(["name", "phone", "email", "instagram", "lead_created_at", "owner", "stage", "ignore"]);
  });

  it("combines first and last name columns", () => {
    const m = suggestMapping(["First name", "Last name", "WhatsApp"], ctx.fields);
    expect([0, 1, 2].map((i) => target(m, i))).toEqual(["name_part:first", "name_part:last", "phone"]);
  });

  it("matches custom fields by label, and never the same field twice", () => {
    const m = suggestMapping(["Struggles", "struggles", "Tier"], ctx.fields);
    expect([0, 1, 2].map((i) => target(m, i))).toEqual(["struggles", "ignore", "tier"]);
  });

  it("never suggests Source, hidden, view-only or archived fields", () => {
    const m = suggestMapping(["Source", "Secret", "Gone"], ctx.fields);
    expect([0, 1, 2].map((i) => target(m, i))).toEqual(["ignore", "ignore", "ignore"]);
  });

  it("starts from a remembered mapping, dropping anything that no longer exists", () => {
    const memory = mapOf(["name", "gone", "tier"]);
    const m = suggestMapping(["Name", "Old", "Tier"], ctx.fields, memory);
    expect([0, 1, 2].map((i) => target(m, i))).toEqual(["name", "ignore", "tier"]);
  });

  it("offers tags and lost reason as targets, never Source", () => {
    const keys = MAPPABLE_TARGETS(ctx.fields).map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(["name", "phone", "tags", "lost_reason", "struggles"]));
    expect(keys).not.toEqual(expect.arrayContaining(["source", "secret", "gone"]));
  });
});

describe("validateMapping", () => {
  const codes = (m: Mapping, r = testRules(), c = ctx) => validateMapping(m, r, c).map((p) => p.code);

  it("accepts a plain mapping", () => expect(codes(mapOf(["name", "phone"]))).toEqual([]));

  it("refuses the same field twice, unknown or archived fields, and fields the importer can't edit", () => {
    expect(codes(mapOf(["name", "name"]))).toContain("FIELD_TWICE");
    expect(codes(mapOf(["name", "nope"]))).toContain("UNKNOWN_FIELD");
    expect(codes(mapOf(["name", "gone"]))).toContain("UNKNOWN_FIELD");
    expect(codes(mapOf(["name", "secret"]))).toContain("FIELD_NOT_EDITABLE");
    expect(codes(mapOf(["name", "source"]))).toContain("SOURCE_NOT_MAPPABLE");
  });

  it("needs a name column only when rows without a name are errors", () => {
    expect(codes(mapOf(["phone"]))).toEqual([]);
    expect(codes(mapOf(["phone"]), testRules({ noName: "error" }))).toContain("NO_NAME_COLUMN");
  });

  it("needs a first name when a last name is mapped", () => {
    const m: Mapping = { columns: [{ column: 0, to: "name_part", part: "last" }], createMissingTags: false };
    expect(codes(m)).toContain("LAST_WITHOUT_FIRST");
  });

  it("checks new fields: permission and a free, unique label", () => {
    const m = (label: string): Mapping => ({ columns: [{ column: 0, to: "field", field: "name" }, { column: 1, to: "new_field", label, type: "text" }], createMissingTags: false });
    expect(codes(m("Referred by"))).toEqual([]);
    expect(codes(m("Tier"))).toContain("NEW_FIELD_LABEL_TAKEN");
    expect(codes(m("Referred by"), testRules(), testContext({ canManageFields: false }))).toContain("NEW_FIELD_NOT_ALLOWED");
  });

  it("asks for a default for every required custom field no column covers (spec amendment 3)", () => {
    const c = testContext({ fields: ctx.fields.map((x) => (x.key === "tier" ? { ...x, isRequired: true } : x)) });
    expect(codes(mapOf(["name"]), testRules(), c)).toContain("REQUIRED_FIELD_UNCOVERED");
    expect(codes(mapOf(["name"]), testRules({ requiredDefaults: { tier: "o-gold" } }), c)).toEqual([]);
    expect(codes(mapOf(["name", "tier"]), testRules(), c)).toEqual([]);
  });

  it("checks new options and tags against the importer's permissions", () => {
    const m = { ...mapOf(["name", "tier"]), addOptions: { tier: ["Platinum"] }, createMissingTags: true };
    expect(codes(m)).toEqual([]);
    expect(codes(m, testRules(), testContext({ canManageFields: false, canManageTags: false }))).toEqual(
      expect.arrayContaining(["NEW_OPTION_NOT_ALLOWED", "NEW_TAG_NOT_ALLOWED"]),
    );
    expect(codes({ ...mapOf(["name", "paid"]), addOptions: { paid: ["Maybe"] } })).toContain("UNKNOWN_FIELD");
  });

  it("checks the rules: stages, owners, and assigning without permission", () => {
    expect(codes(mapOf(["name"]), testRules({ stageId: "s-nope" }))).toContain("UNKNOWN_STAGE");
    expect(codes(mapOf(["name"]), testRules({ reopenClosedTo: "s-won" }))).toContain("REOPEN_NOT_OPEN");
    expect(codes(mapOf(["name"]), testRules({ owner: { mode: "user", userId: "u-old" } }))).toContain("OWNER_INACTIVE");
    expect(codes(mapOf(["name"]), testRules({ owner: { mode: "round_robin", userIds: [] } }))).toContain("ROUND_ROBIN_EMPTY");
    const noAssign = testContext({ canAssign: false });
    expect(codes(mapOf(["name"]), testRules({ owner: { mode: "user", userId: "u-riya" } }), noAssign)).toContain("CANNOT_ASSIGN");
    expect(codes(mapOf(["name"]), testRules({ owner: { mode: "user", userId: "u-me" } }), noAssign)).toEqual([]);
  });

  it("has sensible defaults", () => {
    expect(DEFAULT_RULES({ pipelineId: "p1", stageId: "s-new", country: "AE" })).toEqual(testRules());
  });
});
```

`packages/core/src/intake/map-row.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { analyzeColumns, mapRow, resolveColumnSettings, type Mapping, type RowOutcome } from "./index";
import { mapOf, testContext, testRules } from "./test-context";

const draft = (o: RowOutcome) => {
  if (o.kind !== "draft") throw new Error(`expected a draft, got ${JSON.stringify(o)}`);
  return o;
};
const problems = (o: RowOutcome) => (o.kind === "error" ? o.problems.map((p) => p.code) : []);
const warns = (o: RowOutcome) => (o.kind === "empty" ? [] : o.warnings.map((w) => w.code));
const run = (keys: (string | null)[], cells: string[], rules = testRules(), ctx = testContext({ headerCount: keys.length })) =>
  mapRow(cells, mapOf(keys), rules, ctx);

describe("empty rows and names (§6.1, §6.2, §6.4)", () => {
  it("calls a row with nothing in its mapped cells empty", () => {
    expect(run(["name", "phone", null], ["", "  ", "ignored"]).kind).toBe("empty");
  });

  it("trims and collapses a name, and combines first and last", () => {
    expect(draft(run(["name"], ["  Aisha   Khan "])).draft.name).toBe("Aisha Khan");
    const m: Mapping = { columns: [{ column: 0, to: "name_part", part: "first" }, { column: 1, to: "name_part", part: "last" }], createMissingTags: false };
    expect(draft(mapRow(["Aisha", ""], m, testRules(), testContext({ headerCount: 2 }))).draft.name).toBe("Aisha");
    expect(draft(mapRow(["Aisha", "Khan"], m, testRules(), testContext({ headerCount: 2 }))).draft.name).toBe("Aisha Khan");
  });

  it("uses the contact as the name when there is none, and says so", () => {
    const o = draft(run(["name", "phone", "email"], ["", "0501234567", "a@x.com"]));
    expect(o.draft.name).toBe("+971 50 123 4567");
    expect(o.draft.nameFromContact).toBe(true);
    expect(warns(o)).toContain("NAME_FROM_CONTACT");
    expect(draft(run(["name", "email"], ["", "a@x.com"])).draft.name).toBe("a@x.com");
    expect(draft(run(["name", "instagram"], ["", "@aisha"])).draft.name).toBe("@aisha");
  });

  it("refuses a row with no name and no contact, and no name at all when asked", () => {
    expect(problems(run(["name", "email", "tier"], ["", "", "Gold"]))).toEqual(["NO_NAME_NO_CONTACT"]);
    expect(problems(run(["name", "phone"], ["", "0501234567"], testRules({ noName: "error" })))).toEqual(["NO_NAME"]);
    expect(problems(run(["name"], ["x".repeat(201)]))).toEqual(["NAME_TOO_LONG"]);
  });

  it("refuses a cell over 10,000 characters, and warns about extra cells", () => {
    expect(problems(run(["name", "notes"], ["A", "x".repeat(10_001)]))).toContain("CELL_TOO_LONG");
    expect(warns(run(["name"], ["A", "extra", "more"]))).toContain("EXTRA_CELLS");
  });
});

describe("contacts (§6.3)", () => {
  it("normalises phones with the default country, keeping the raw value", () => {
    const o = draft(run(["name", "phone"], ["A", "050 123 4567"]));
    expect(o.draft.phone).toMatchObject({ raw: "050 123 4567", e164: "+971501234567", status: "valid" });
  });

  it("imports unreadable phones with a warning, never an error", () => {
    const o = draft(run(["name", "phone"], ["A", "12345"]));
    expect(o.draft.phone.status).toBe("invalid");
    expect(warns(o)).toContain("PHONE_INVALID");
    const local = draft(run(["name", "phone"], ["A", "0501234567"], testRules({ defaultCountry: null }), testContext({ country: null, headerCount: 2 })));
    expect(local.draft.phone.status).toBe("needs_country");
    expect(warns(local)).toContain("PHONE_NEEDS_COUNTRY");
  });

  it("keeps an Excel-shortened number as invalid, saying exactly what happened", () => {
    const o = draft(run(["name", "phone"], ["A", "9.71501E+11"]));
    expect(o.draft.phone).toMatchObject({ raw: "9.71501E+11", e164: null, status: "invalid" });
    expect(o.warnings.find((w) => w.code === "PHONE_EXCEL")?.message).toMatch(/Excel shortened this number/);
  });

  it("takes the first of several numbers and keeps the rest for the history", () => {
    const o = draft(run(["name", "phone"], ["A", "050 111 2222 / 055 333 4444"]));
    expect(o.draft.phone.e164).toBe("+971501112222");
    expect(o.draft.extraPhones).toEqual(["055 333 4444"]);
    expect(warns(o)).toContain("PHONE_EXTRA");
  });

  it("drops an invalid email or Instagram handle with a warning", () => {
    const o = draft(run(["name", "email", "instagram"], ["A", "not-an-email", "bad handle!"]));
    expect(o.draft.email).toBeNull();
    expect(o.draft.instagram).toBeNull();
    expect(warns(o)).toEqual(expect.arrayContaining(["EMAIL_INVALID", "INSTAGRAM_INVALID"]));
    expect(draft(run(["name", "instagram"], ["A", "instagram.com/Aisha.K"])).draft.instagram).toBe("aisha.k");
  });
});

describe("stage, owner, lost reason (§6.5, §6.6)", () => {
  it("matches a stage by name within the pipeline, ignoring case and spaces", () => {
    const o = draft(run(["name", "stage"], ["A", "  call   BOOKED "]));
    expect(o.draft).toMatchObject({ stageId: "s-booked", stageKind: "open" });
  });

  it("refuses an unknown stage by name", () => {
    const o = run(["name", "stage"], ["A", "Proposal"]);
    expect(o.kind === "error" && o.problems[0]!.message).toBe("No stage called “Proposal” in this pipeline.");
  });

  it("uses a value map for stages", () => {
    const m = mapOf(["name", "stage"]);
    m.columns[1] = { column: 1, to: "field", field: "stage", transform: { valueMap: { proposal: "Call booked", junk: null } } };
    expect(draft(mapRow(["A", "Proposal"], m, testRules(), testContext({ headerCount: 2 }))).draft.stageId).toBe("s-booked");
    expect(draft(mapRow(["A", "junk"], m, testRules(), testContext({ headerCount: 2 }))).draft.stageId).toBeNull();
  });

  it("keeps a lost reason only on a Lost stage", () => {
    expect(draft(run(["name", "stage", "lost_reason"], ["A", "Lost", "price"])).draft.lostReasonId).toBe("r-price");
    const o = draft(run(["name", "stage", "lost_reason"], ["A", "New", "Price"]));
    expect(o.draft.lostReasonId).toBeNull();
    expect(warns(o)).toContain("LOST_REASON_IGNORED");
    expect(problems(run(["name", "stage", "lost_reason"], ["A", "Lost", "Too far"]))).toContain("LOST_REASON_UNKNOWN");
  });

  it("matches an owner by email, or by a name only one active person has", () => {
    expect(draft(run(["name", "owner"], ["A", "RIYA@brightpath.test"])).draft.ownerId).toBe("u-riya");
    expect(draft(run(["name", "owner"], ["A", "riya sharma"])).draft.ownerId).toBe("u-riya");
    expect(problems(run(["name", "owner"], ["A", "Sam Lee"]))).toEqual(["OWNER_AMBIGUOUS"]);
  });

  it("falls back to the owner rule for an unknown or disabled owner, or refuses when asked", () => {
    const o = draft(run(["name", "owner"], ["A", "Omar Gone"]));
    expect(o.draft.ownerId).toBeUndefined();
    expect(warns(o)).toContain("OWNER_UNKNOWN");
    expect(problems(run(["name", "owner"], ["A", "Nobody"], testRules({ unknownOwner: "error" })))).toEqual(["OWNER_UNKNOWN"]);
  });

  it("an importer who can't assign may only own leads themselves", () => {
    const c = testContext({ canAssign: false, headerCount: 2 });
    expect(problems(run(["name", "owner"], ["A", "Riya Sharma"], testRules(), c))).toEqual(["CANNOT_ASSIGN"]);
    expect(draft(run(["name", "owner"], ["A", "maya@brightpath.test"], testRules(), c)).draft.ownerId).toBe("u-me");
  });

  it("leaves the owner to the rule when the cell is empty", () => {
    expect(draft(run(["name", "owner"], ["A", ""])).draft.ownerId).toBeUndefined();
  });
});

describe("dates and money (§6.7, §6.8)", () => {
  it("reads the created date with the column's order", () => {
    const c = testContext({ headerCount: 2, dateOrders: { 1: "DMY" } });
    expect(draft(run(["name", "lead_created_at"], ["A", "04/03/2026"], testRules(), c)).draft.leadCreatedAt).toBe("2026-03-04");
    expect(problems(run(["name", "lead_created_at"], ["A", "30/09/2026"], testRules(), c))).toEqual(["DATE_FUTURE"]);
  });

  it("reads the value in the business currency, and refuses another", () => {
    const c = testContext({ headerCount: 2, decimalMarks: { 1: "." } });
    expect(draft(run(["name", "value"], ["A", "AED 4,500"], testRules(), c)).draft.value).toBe(4500);
    expect(problems(run(["name", "value"], ["A", "$4,500"], testRules(), c))).toEqual(["FOREIGN_CURRENCY"]);
  });

  it("reads a datetime field as an instant", () => {
    const c = testContext({ headerCount: 2, dateOrders: { 1: "YMD" } });
    expect(draft(run(["name", "call_at"], ["A", "2026-03-04 10:30"], testRules(), c)).draft.custom.call_at).toBe("2026-03-04T06:30:00.000Z");
  });
});

describe("custom fields (§6.8)", () => {
  it("matches options by label, ignoring case and accents, never an archived one", () => {
    expect(draft(run(["name", "tier"], ["A", " gold "])).draft.custom.tier).toBe("o-gold");
    expect(problems(run(["name", "tier"], ["A", "Bronze"]))).toEqual(["OPTION_UNKNOWN"]);
  });

  it("splits multi-choice values and de-duplicates them", () => {
    expect(draft(run(["name", "struggles"], ["A", "Confidence; career switch, confidence"])).draft.custom.struggles).toEqual(["o-conf", "o-career"]);
  });

  it("reads yes/no, and refuses anything else", () => {
    expect(draft(run(["name", "paid"], ["A", "Y"])).draft.custom.paid).toBe(true);
    expect(problems(run(["name", "paid"], ["A", "maybe"]))).toEqual(["NOT_YES_NO"]);
  });

  it("drops an invalid link or phone in a custom field with a warning", () => {
    const o = draft(run(["name", "website", "alt_phone"], ["A", "not a link", "123"]));
    expect(o.draft.custom).toEqual({});
    expect(warns(o)).toEqual(expect.arrayContaining(["URL_INVALID", "PHONE_INVALID"]));
  });

  it("matches person fields like owners, with no fallback", () => {
    expect(draft(run(["name", "coach"], ["A", "Riya Sharma"])).draft.custom.coach).toBe("u-riya");
    expect(problems(run(["name", "coach"], ["A", "Nobody"]))).toEqual(["PERSON_UNKNOWN"]);
  });

  it("refuses text longer than the field allows", () => {
    expect(problems(run(["name", "website"], ["A", `https://x.test/${"a".repeat(2000)}`]))).toContain("VALUE_TOO_LONG");
  });

  it("fills required fields from the rules' defaults, or refuses the row (spec amendment 3)", () => {
    const c = testContext({ headerCount: 1, fields: testContext().fields.map((x) => (x.key === "tier" ? { ...x, isRequired: true } : x)) });
    expect(problems(run(["name"], ["A"], testRules(), c))).toEqual(["REQUIRED_MISSING"]);
    expect(draft(run(["name"], ["A"], testRules({ requiredDefaults: { tier: "o-silver" } }), c)).draft.custom.tier).toBe("o-silver");
  });
});

describe("tags", () => {
  it("matches tags by label, and refuses unknown ones (they're created at Start when chosen)", () => {
    expect(draft(run(["name", "tags"], ["A", "hot, VIP, Hot"])).draft.tagIds).toEqual(["t-hot", "t-vip"]);
    expect(problems(run(["name", "tags"], ["A", "Cold"]))).toEqual(["TAG_UNKNOWN"]);
  });
});

describe("analyzeColumns and resolveColumnSettings", () => {
  const rows = [
    ["A", "13/03/2026", "Gold", "1.234,50", "Proposal"],
    ["B", "04/03/2026", "Platinum", "99,00", "New"],
    ["C", "05/03/2026", "Platinum", "12", "Proposal"],
  ];
  const m = mapOf(["name", "lead_created_at", "tier", "value", "stage"]);
  const c = testContext({ headerCount: 5 });

  it("finds each column's date order, decimal mark and unmatched values with counts", () => {
    const a = analyzeColumns(rows, m, c);
    expect(a[1]).toMatchObject({ dateOrder: "DMY" });
    expect(a[2]!.unmatched).toEqual([{ value: "Platinum", rows: 2 }]);
    expect(a[3]).toMatchObject({ decimalMark: "," });
    expect(a[4]!.unmatched).toEqual([{ value: "Proposal", rows: 2 }]);
  });

  it("blocks on a conflicting date column until the importer chooses, and defaults an ambiguous one", () => {
    const conflicted = analyzeColumns([["A", "13/03/2026"], ["B", "03/13/2026"]], mapOf(["name", "lead_created_at"]), testContext({ headerCount: 2 }));
    expect(resolveColumnSettings(conflicted, mapOf(["name", "lead_created_at"]), { country: "AE" }).blocking.map((b) => b.code)).toEqual(["DATE_ORDER_NEEDED"]);
    const chosen = mapOf(["name", "lead_created_at"]);
    chosen.columns[1] = { column: 1, to: "field", field: "lead_created_at", transform: { dateOrder: "MDY" } };
    expect(resolveColumnSettings(conflicted, chosen, { country: "AE" })).toMatchObject({ dateOrders: { 1: "MDY" }, blocking: [] });
    const ambiguous = analyzeColumns([["A", "03/04/2026"]], mapOf(["name", "lead_created_at"]), testContext({ headerCount: 2 }));
    expect(resolveColumnSettings(ambiguous, mapOf(["name", "lead_created_at"]), { country: "US" }).dateOrders).toEqual({ 1: "MDY" });
  });

  it("treats an option chosen to be added as matched", () => {
    const adding = { ...mapOf(["name", "lead_created_at", "tier", "value", "stage"]), addOptions: { tier: ["Platinum"] } };
    expect(analyzeColumns(rows, adding, c)[2]!.unmatched).toEqual([]);
  });

  it("treats a value mapped in the unmatched panel as matched", () => {
    const mapped = mapOf(["name", "lead_created_at", "tier", "value", "stage"]);
    mapped.columns[2] = { column: 2, to: "field", field: "tier", transform: { valueMap: { platinum: "Gold" } } };
    expect(analyzeColumns(rows, mapped, c)[2]!.unmatched).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core/src/intake'`
Expected: FAIL — `Failed to resolve import "./mapping"`.

- [ ] **Step 4: Implement `mapping.ts`**

```ts
import type { FieldType } from "../leads/custom-fields";
import { fold, type DateOrder } from "./values";

export type Transform = { case?: "lower" | "title"; dateOrder?: DateOrder; defaultCountry?: string; valueMap?: Record<string, string | null>; splitOn?: "," | ";" | "|" };
export type ColumnMap =
  | { column: number; to: "ignore" }
  | { column: number; to: "field"; field: string; transform?: Transform }
  | { column: number; to: "name_part"; part: "first" | "last"; transform?: Transform }
  | { column: number; to: "new_field"; label: string; type: FieldType; transform?: Transform };
export type Mapping = { columns: ColumnMap[]; createMissingTags: boolean; addOptions?: Record<string, string[]> }; // addOptions: field key → labels to create at Start
export type OwnerRule = { mode: "unassigned" } | { mode: "user"; userId: string } | { mode: "round_robin"; userIds: string[] };
export type Rules = {
  matchOn: ("phone" | "email" | "instagram")[];
  onMatch: "merge" | "skip" | "duplicate";
  reopenClosedTo: string | null;
  pipelineId: string;
  stageId: string;
  owner: OwnerRule;
  defaultCountry: string | null;
  noName: "use_contact" | "error";
  unknownOwner: "fallback" | "error";
  requiredDefaults: Record<string, unknown>;
};
export type IntakeField = {
  id: string; key: string; label: string; type: FieldType;
  options: { id: string; label: string; archived?: boolean }[];
  isCore: boolean; isRequired: boolean; archived: boolean; access: "edit" | "view" | "hidden";
};
export type MapContext = {
  fields: IntakeField[];
  stages: { id: string; name: string; kind: "open" | "won" | "lost" }[];
  people: { id: string; name: string; email: string; active: boolean }[];
  tags: { id: string; label: string }[];
  lostReasons: { id: string; label: string }[];
  currency: string;
  country: string | null;
  today: string;
  timezone: string;
  importerId: string;
  canAssign: boolean;
  canManageFields: boolean;
  canManageTags: boolean;
  headerCount: number;
  dateOrders: Record<number, DateOrder>;
  decimalMarks: Record<number, "." | ",">;
};
export type Issue = { column: number | null; code: string; message: string };

/** Targets that aren't field definitions but can take a column. */
export const PSEUDO_TARGETS = [
  { key: "tags", label: "Tags" },
  { key: "lost_reason", label: "Lost reason" },
] as const;

const usable = (f: IntakeField) => !f.archived && f.access === "edit" && f.key !== "source";

export const MAPPABLE_TARGETS = (fields: IntakeField[]) => [
  ...fields
    .filter(usable)
    .map((f) => ({
      key: f.key,
      label: f.label,
      group: (["phone", "email", "instagram"].includes(f.key) ? "Contact" : f.isCore ? "Lead" : "Custom") as "Contact" | "Lead" | "Custom",
    })),
  ...PSEUDO_TARGETS.map((t) => ({ ...t, group: "Lead" as const })),
];

export const DEFAULT_RULES = (o: { pipelineId: string; stageId: string; country: string | null }): Rules => ({
  matchOn: ["phone", "email", "instagram"],
  onMatch: "merge",
  reopenClosedTo: null,
  pipelineId: o.pipelineId,
  stageId: o.stageId,
  owner: { mode: "unassigned" },
  defaultCountry: o.country,
  noName: "use_contact",
  unknownOwner: "fallback",
  requiredDefaults: {},
});

/** Header words → target key. Folded, punctuation removed. "source" is deliberately absent (amendment 4). */
const SYNONYMS: Record<string, string> = {
  name: "name", "full name": "name", "client name": "name", "lead name": "name", "customer name": "name", contact: "name",
  phone: "phone", mobile: "phone", "mobile no": "phone", "mobile number": "phone", "phone number": "phone", whatsapp: "phone", "whatsapp number": "phone", "contact number": "phone", cell: "phone", tel: "phone", telephone: "phone",
  email: "email", "e mail": "email", "email address": "email", mail: "email",
  instagram: "instagram", ig: "instagram", "instagram handle": "instagram", "instagram username": "instagram", insta: "instagram",
  owner: "owner", "assigned to": "owner", "handled by": "owner", "sales rep": "owner", rep: "owner", agent: "owner",
  stage: "stage", status: "stage", "pipeline stage": "stage",
  value: "value", amount: "value", "deal value": "value", price: "value", revenue: "value",
  date: "lead_created_at", created: "lead_created_at", "created at": "lead_created_at", "date created": "lead_created_at", timestamp: "lead_created_at", "submitted at": "lead_created_at", "enquiry date": "lead_created_at",
  tags: "tags", tag: "tags", labels: "tags",
  "lost reason": "lost_reason", "reason lost": "lost_reason",
};
const NAME_PARTS: Record<string, "first" | "last"> = { "first name": "first", firstname: "first", "given name": "first", "last name": "last", lastname: "last", surname: "last", "family name": "last" };

const clean = (h: string) => fold(h).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export function suggestMapping(headers: string[], fields: IntakeField[], memory?: Mapping | null): Mapping {
  const targets = new Map(MAPPABLE_TARGETS(fields).map((t) => [t.key, t]));
  const used = new Set<string>();
  const columns: ColumnMap[] = headers.map((h, column) => {
    const remembered = memory?.columns.find((c) => c.column === column);
    if (remembered && remembered.to !== "ignore") {
      if (remembered.to === "field" && targets.has(remembered.field) && !used.has(remembered.field)) {
        used.add(remembered.field);
        return { ...remembered, column };
      }
      if (remembered.to === "name_part" && !used.has(`name_part:${remembered.part}`)) {
        used.add(`name_part:${remembered.part}`);
        return { ...remembered, column };
      }
    }
    const key = clean(h);
    const part = NAME_PARTS[key];
    if (part && !used.has(`name_part:${part}`) && !used.has("name")) {
      used.add(`name_part:${part}`);
      return { column, to: "name_part", part };
    }
    const byLabel = [...targets.values()].find((t) => clean(t.label) === key || t.key === key.replace(/ /g, "_"));
    const target = SYNONYMS[key] ?? byLabel?.key;
    if (target && targets.has(target) && !used.has(target) && !(target === "name" && (used.has("name_part:first") || used.has("name_part:last")))) {
      used.add(target);
      return { column, to: "field", field: target };
    }
    return { column, to: "ignore" };
  });
  return { columns, createMissingTags: memory?.createMissingTags ?? false };
}

const issue = (column: number | null, code: string, message: string): Issue => ({ column, code, message });

/** Spec §5.3–§5.4 and amendment 3. Empty means the import may start. */
export function validateMapping(m: Mapping, r: Rules, ctx: MapContext): Issue[] {
  const out: Issue[] = [];
  const byKey = new Map(ctx.fields.map((f) => [f.key, f]));
  const seen = new Set<string>();
  const pseudo = new Set<string>(PSEUDO_TARGETS.map((t) => t.key));
  let first = false;
  let last = false;
  const newLabels = new Set<string>();
  for (const c of m.columns) {
    if (c.to === "field") {
      if (c.field === "source") out.push(issue(c.column, "SOURCE_NOT_MAPPABLE", "Source is the import itself. Map this column to a new field instead."));
      else if (!pseudo.has(c.field)) {
        const f = byKey.get(c.field);
        if (!f || f.archived) out.push(issue(c.column, "UNKNOWN_FIELD", "That field no longer exists."));
        else if (f.access !== "edit") out.push(issue(c.column, "FIELD_NOT_EDITABLE", `Your role can't fill in ${f.label}.`));
      }
      if (seen.has(c.field)) out.push(issue(c.column, "FIELD_TWICE", "Two columns go to the same field."));
      seen.add(c.field);
    }
    if (c.to === "name_part") {
      if (c.part === "first") first = true;
      else last = true;
    }
    if (c.to === "new_field") {
      const label = fold(c.label);
      if (!ctx.canManageFields) out.push(issue(c.column, "NEW_FIELD_NOT_ALLOWED", "Your role can't create fields."));
      if (!label) out.push(issue(c.column, "NEW_FIELD_LABEL_TAKEN", "Give the new field a name."));
      else if (ctx.fields.some((f) => !f.archived && fold(f.label) === label) || newLabels.has(label))
        out.push(issue(c.column, "NEW_FIELD_LABEL_TAKEN", `A field called “${c.label}” already exists.`));
      newLabels.add(label);
    }
  }
  for (const [key, labels] of Object.entries(m.addOptions ?? {})) {
    const f = byKey.get(key);
    if (!labels.length) continue;
    if (!ctx.canManageFields) out.push(issue(null, "NEW_OPTION_NOT_ALLOWED", "Your role can't add options to fields."));
    else if (!f || f.archived || (f.type !== "select" && f.type !== "multi_select"))
      out.push(issue(null, "UNKNOWN_FIELD", "Options can only be added to a choice field."));
  }
  if (m.createMissingTags && !ctx.canManageTags) out.push(issue(null, "NEW_TAG_NOT_ALLOWED", "Your role can't create tags."));
  if (last && !first) out.push(issue(null, "LAST_WITHOUT_FIRST", "Map a first-name column too."));
  if (seen.has("name") && (first || last)) out.push(issue(null, "FIELD_TWICE", "Name is mapped twice (a name column and name parts)."));
  if (r.noName === "error" && !seen.has("name") && !first)
    out.push(issue(null, "NO_NAME_COLUMN", "Map a name column, or let rows without a name use their contact."));
  for (const f of ctx.fields)
    if (!f.isCore && f.isRequired && !f.archived && !seen.has(f.key) && r.requiredDefaults[f.key] === undefined)
      out.push(issue(null, "REQUIRED_FIELD_UNCOVERED", `${f.label} is needed on every lead: map a column to it or choose a default.`));

  const stage = ctx.stages.find((s) => s.id === r.stageId);
  if (!stage) out.push(issue(null, "UNKNOWN_STAGE", "Choose the stage new leads enter."));
  if (r.reopenClosedTo !== null && ctx.stages.find((s) => s.id === r.reopenClosedTo)?.kind !== "open")
    out.push(issue(null, "REOPEN_NOT_OPEN", "Closed leads can only reopen to an open stage."));
  const active = (id: string) => ctx.people.some((p) => p.id === id && p.active);
  if (r.owner.mode === "user") {
    if (!active(r.owner.userId)) out.push(issue(null, "OWNER_INACTIVE", "That person can't take leads."));
    else if (!ctx.canAssign && r.owner.userId !== ctx.importerId) out.push(issue(null, "CANNOT_ASSIGN", "Your role can only give imported leads to you."));
  }
  if (r.owner.mode === "round_robin") {
    if (!r.owner.userIds.length) out.push(issue(null, "ROUND_ROBIN_EMPTY", "Choose who takes turns."));
    else if (r.owner.userIds.some((id) => !active(id))) out.push(issue(null, "OWNER_INACTIVE", "Someone chosen to take turns can't take leads."));
    else if (!ctx.canAssign && r.owner.userIds.some((id) => id !== ctx.importerId)) out.push(issue(null, "CANNOT_ASSIGN", "Your role can only give imported leads to you."));
  }
  if (!r.matchOn.length && r.onMatch !== "duplicate") out.push(issue(null, "MATCH_ON_EMPTY", "Choose at least one way to recognise an existing lead."));
  return out;
}
```

- [ ] **Step 5: Implement `map-row.ts`**

```ts
import { formatPhone, normalizePhone, type NormalizedPhone } from "../leads/phone";
import { INTAKE_LIMITS } from "./limits";
import type { ColumnMap, Issue, IntakeField, MapContext, Mapping, Rules } from "./mapping";
import {
  defaultDateOrder,
  defaultDecimalMark,
  detectDateOrder,
  detectDecimalMark,
  fold,
  isScientific,
  parseBoolean,
  parseDate,
  parseMoney,
  parseNumber,
  readEmail,
  readInstagram,
  readUrl,
  splitPhones,
  type DateOrder,
} from "./values";

export type LeadDraft = {
  name: string;
  nameFromContact: boolean;
  phone: NormalizedPhone;
  extraPhones: string[];
  email: string | null;
  instagram: string | null;
  stageId: string | null;
  stageKind: "open" | "won" | "lost" | null;
  ownerId: string | null | undefined;
  value: number | null;
  leadCreatedAt: string | null;
  lostReasonId: string | null;
  custom: Record<string, unknown>;
  tagIds: string[];
};
export type RowOutcome =
  | { kind: "empty" }
  | { kind: "draft"; draft: LeadDraft; warnings: Issue[] }
  | { kind: "error"; problems: Issue[]; warnings: Issue[] };
export type ColumnAnalysis = { column: number; dateOrder?: DateOrder | "conflict" | "ambiguous"; decimalMark?: "." | ","; unmatched: { value: string; rows: number }[] };

const TEXT_MAX: Partial<Record<IntakeField["type"], number>> = { text: 500, long_text: 10_000, url: 2000, email: 254 };
const NAME_MAX = 200;
const DATE_TYPES = new Set(["date", "datetime"]);
const MONEY_TYPES = new Set(["currency"]);
const issue = (column: number | null, code: string, message: string): Issue => ({ column, code, message });
const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

function applyCase(v: string, c?: "lower" | "title") {
  return c === "lower" ? v.toLowerCase() : c === "title" ? titleCase(v.toLowerCase()) : v;
}

/** The target key a column feeds, or null. */
const keyOf = (c: ColumnMap): string | null => (c.to === "field" ? c.field : null);

function fieldOf(ctx: MapContext, key: string) {
  return ctx.fields.find((f) => f.key === key && !f.archived);
}

/** A raw cell through the column's value map: undefined = not mapped, null = "leave empty". */
function viaMap(c: ColumnMap, raw: string): string | null | undefined {
  if (c.to === "ignore" || !c.transform?.valueMap) return undefined;
  const map = c.transform.valueMap;
  const hit = Object.keys(map).find((k) => fold(k) === fold(raw));
  return hit === undefined ? undefined : map[hit]!;
}

function matchPerson(ctx: MapContext, raw: string) {
  const v = fold(raw);
  const byEmail = ctx.people.filter((p) => fold(p.email) === v);
  if (byEmail.length) return { person: byEmail[0]!, ambiguous: false };
  const byName = ctx.people.filter((p) => fold(p.name) === v);
  const activeByName = byName.filter((p) => p.active);
  if (activeByName.length > 1) return { person: null, ambiguous: true };
  return { person: activeByName[0] ?? byName[0] ?? null, ambiguous: false };
}

const splitter = (c: ColumnMap) => {
  const on = c.to !== "ignore" ? c.transform?.splitOn : undefined;
  return on ? new RegExp(`\\s*\\${on}\\s*`) : /\s*[,;]\s*/;
};

/** Spec §6: one row → a draft lead, or the reasons it can't become one. Never touches a database. */
export function mapRow(cells: string[], m: Mapping, r: Rules, ctx: MapContext): RowOutcome {
  const warnings: Issue[] = [];
  const problems: Issue[] = [];
  const mapped = m.columns.filter((c) => c.to !== "ignore");
  const cell = (c: ColumnMap) => (cells[c.column] ?? "").replace(/ /g, " ").trim();
  if (mapped.every((c) => cell(c) === "")) return { kind: "empty" };
  if (cells.length > ctx.headerCount) {
    const extra = cells.slice(ctx.headerCount).filter((x) => x.trim() !== "");
    if (extra.length) warnings.push(issue(null, "EXTRA_CELLS", `${extra.length} cells past the last column were left out.`));
  }
  for (const c of mapped)
    if (cell(c).length > INTAKE_LIMITS.cellChars) problems.push(issue(c.column, "CELL_TOO_LONG", "Too long (over 10,000 characters)."));
  if (problems.length) return { kind: "error", problems, warnings };

  const d: LeadDraft = {
    name: "", nameFromContact: false, phone: { raw: null, e164: null, countryIso: null, status: "missing" }, extraPhones: [],
    email: null, instagram: null, stageId: null, stageKind: null, ownerId: undefined, value: null, leadCreatedAt: null,
    lostReasonId: null, custom: {}, tagIds: [],
  };
  let first = "";
  let last = "";
  let lostCol: { column: number; raw: string } | null = null;

  for (const c of mapped) {
    const raw0 = cell(c);
    if (raw0 === "") continue;
    const mappedValue = viaMap(c, raw0);
    if (mappedValue === null) continue; // "leave empty"
    const raw = mappedValue ?? raw0;
    if (c.to === "name_part") {
      const v = applyCase(raw.replace(/\s+/g, " "), c.transform?.case);
      if (c.part === "first") first = v;
      else last = v;
      continue;
    }
    if (c.to === "new_field") {
      const f: IntakeField = { id: "", key: `new:${c.column}`, label: c.label, type: c.type, options: [], isCore: false, isRequired: false, archived: false, access: "edit" };
      readCustom(f, c, raw, d, ctx, problems, warnings);
      continue;
    }
    const key = keyOf(c)!;
    switch (key) {
      case "name":
        d.name = applyCase(raw.replace(/\s+/g, " "), c.to === "field" ? c.transform?.case : undefined);
        break;
      case "phone": {
        if (isScientific(raw)) {
          d.phone = { raw, e164: null, countryIso: null, status: "invalid" };
          warnings.push(issue(c.column, "PHONE_EXCEL", "Excel shortened this number; the full number is lost — re-export the column as text."));
          break;
        }
        const [one, ...rest] = splitPhones(raw);
        const country = (c.to === "field" && c.transform?.defaultCountry) || r.defaultCountry;
        d.phone = normalizePhone(one, country);
        if (rest.length) {
          d.extraPhones = rest;
          warnings.push(issue(c.column, "PHONE_EXTRA", `Kept ${rest.length === 1 ? "another number" : `${rest.length} more numbers`} in the history: ${rest.join(", ")}.`));
        }
        if (d.phone.status === "invalid") warnings.push(issue(c.column, "PHONE_INVALID", `“${one}” isn't a phone number LUME can read; it's kept as typed.`));
        if (d.phone.status === "needs_country") warnings.push(issue(c.column, "PHONE_NEEDS_COUNTRY", `“${one}” needs a country code; it's kept as typed.`));
        break;
      }
      case "email":
        d.email = readEmail(raw);
        if (!d.email) warnings.push(issue(c.column, "EMAIL_INVALID", `Not an email address: “${raw}”. Left empty.`));
        break;
      case "instagram":
        d.instagram = readInstagram(raw);
        if (!d.instagram) warnings.push(issue(c.column, "INSTAGRAM_INVALID", `Not an Instagram handle: “${raw}”. Left empty.`));
        break;
      case "stage": {
        const s = ctx.stages.find((x) => fold(x.name) === fold(raw));
        if (!s) problems.push(issue(c.column, "STAGE_UNKNOWN", `No stage called “${raw}” in this pipeline.`));
        else {
          d.stageId = s.id;
          d.stageKind = s.kind;
        }
        break;
      }
      case "lost_reason":
        lostCol = { column: c.column, raw };
        break;
      case "owner": {
        const { person, ambiguous } = matchPerson(ctx, raw);
        if (ambiguous) problems.push(issue(c.column, "OWNER_AMBIGUOUS", `More than one person is called “${raw}”; use their email.`));
        else if (!person || !person.active) {
          if (r.unknownOwner === "error") problems.push(issue(c.column, "OWNER_UNKNOWN", `No active person “${raw}”.`));
          else warnings.push(issue(c.column, "OWNER_UNKNOWN", `No active person “${raw}”; used the owner rule.`));
        } else if (!ctx.canAssign && person.id !== ctx.importerId)
          problems.push(issue(c.column, "CANNOT_ASSIGN", "You can't assign leads to others."));
        else d.ownerId = person.id;
        break;
      }
      case "value": {
        const p = parseMoney(raw, ctx.decimalMarks[c.column] ?? defaultDecimalMark(ctx.country), ctx.currency);
        if (!p.ok) problems.push(issue(c.column, p.issue.code, p.issue.message));
        else {
          d.value = p.value;
          if (p.warning) warnings.push(issue(c.column, p.warning.code, p.warning.message));
        }
        break;
      }
      case "lead_created_at": {
        const p = parseDate(raw, ctx.dateOrders[c.column] ?? defaultDateOrder(ctx.country), ctx);
        if (!p.ok) problems.push(issue(c.column, p.issue.code, p.issue.message));
        else d.leadCreatedAt = p.value.date;
        break;
      }
      case "tags": {
        const ids = new Set<string>();
        for (const part of raw.split(splitter(c)).filter(Boolean)) {
          const t = ctx.tags.find((x) => fold(x.label) === fold(part));
          if (!t) problems.push(issue(c.column, "TAG_UNKNOWN", `No tag called “${part}”.`));
          else ids.add(t.id);
        }
        d.tagIds = [...ids];
        break;
      }
      default: {
        const f = fieldOf(ctx, key);
        if (f) readCustom(f, c, raw, d, ctx, problems, warnings);
      }
    }
  }

  if (first || last) d.name = [first, last].filter(Boolean).join(" ");
  if (lostCol) {
    const reason = ctx.lostReasons.find((x) => fold(x.label) === fold(lostCol!.raw));
    if (d.stageKind !== "lost") warnings.push(issue(lostCol.column, "LOST_REASON_IGNORED", "A lost reason only applies to a Lost stage; left out."));
    else if (!reason) problems.push(issue(lostCol.column, "LOST_REASON_UNKNOWN", `No lost reason called “${lostCol.raw}”.`));
    else d.lostReasonId = reason.id;
  }

  // Required custom fields (amendment 3): a mapped value, else the rules' default, else the row fails.
  for (const f of ctx.fields)
    if (!f.isCore && f.isRequired && !f.archived && (d.custom[f.key] === undefined || d.custom[f.key] === null)) {
      const fallback = r.requiredDefaults[f.key];
      if (fallback !== undefined) d.custom[f.key] = fallback;
      else problems.push(issue(null, "REQUIRED_MISSING", `${f.label} is needed on every lead.`));
    }

  if (!d.name) {
    const contact = d.phone.e164 ? formatPhone(d.phone.e164) : d.phone.raw ?? d.email ?? (d.instagram ? `@${d.instagram}` : null);
    if (r.noName === "error") problems.push(issue(null, "NO_NAME", "No name."));
    else if (!contact) problems.push(issue(null, "NO_NAME_NO_CONTACT", "No name and no contact."));
    else {
      d.name = contact;
      d.nameFromContact = true;
      warnings.push(issue(null, "NAME_FROM_CONTACT", "No name; used the contact instead."));
    }
  }
  if (d.name.length > NAME_MAX) problems.push(issue(null, "NAME_TOO_LONG", "Name is longer than 200 characters."));
  return problems.length ? { kind: "error", problems, warnings } : { kind: "draft", draft: d, warnings };
}

function readCustom(f: IntakeField, c: ColumnMap, raw: string, d: LeadDraft, ctx: MapContext, problems: Issue[], warnings: Issue[]) {
  const col = c.column;
  const max = TEXT_MAX[f.type];
  if (max !== undefined && raw.length > max) {
    problems.push(issue(col, "VALUE_TOO_LONG", `${f.label} is limited to ${max.toLocaleString("en")} characters.`));
    return;
  }
  const live = f.options.filter((o) => !o.archived);
  const option = (v: string) => live.find((o) => fold(o.label) === fold(v));
  switch (f.type) {
    case "text":
    case "long_text":
      d.custom[f.key] = applyCase(raw, c.to !== "ignore" ? c.transform?.case : undefined);
      return;
    case "number": {
      const p = parseNumber(raw, ctx.decimalMarks[col] ?? defaultDecimalMark(ctx.country));
      if (p.ok) d.custom[f.key] = p.value;
      else problems.push(issue(col, p.issue.code, p.issue.message));
      return;
    }
    case "currency": {
      const p = parseMoney(raw, ctx.decimalMarks[col] ?? defaultDecimalMark(ctx.country), ctx.currency);
      if (!p.ok) problems.push(issue(col, p.issue.code, p.issue.message));
      else {
        d.custom[f.key] = p.value;
        if (p.warning) warnings.push(issue(col, p.warning.code, p.warning.message));
      }
      return;
    }
    case "date":
    case "datetime": {
      const p = parseDate(raw, ctx.dateOrders[col] ?? defaultDateOrder(ctx.country), ctx);
      if (!p.ok) problems.push(issue(col, p.issue.code, p.issue.message));
      else d.custom[f.key] = f.type === "date" ? p.value.date : p.value.instant;
      return;
    }
    case "boolean": {
      const b = parseBoolean(raw);
      if (b === null) problems.push(issue(col, "NOT_YES_NO", `“${raw}” isn't yes or no.`));
      else d.custom[f.key] = b;
      return;
    }
    case "select": {
      const o = option(raw);
      if (!o) problems.push(issue(col, "OPTION_UNKNOWN", `“${raw}” isn't an option for ${f.label}.`));
      else d.custom[f.key] = o.id;
      return;
    }
    case "multi_select": {
      const ids: string[] = [];
      for (const part of raw.split(splitter(c)).filter(Boolean)) {
        const mappedPart = viaMap(c, part);
        if (mappedPart === null) continue;
        const o = option(mappedPart ?? part);
        if (!o) problems.push(issue(col, "OPTION_UNKNOWN", `“${part}” isn't an option for ${f.label}.`));
        else if (!ids.includes(o.id)) ids.push(o.id);
      }
      if (ids.length) d.custom[f.key] = ids;
      return;
    }
    case "phone": {
      const p = normalizePhone(raw, ctx.country);
      if (p.status === "valid") d.custom[f.key] = p.e164;
      else warnings.push(issue(col, "PHONE_INVALID", `${f.label}: “${raw}” isn't a phone number LUME can read. Left empty.`));
      return;
    }
    case "email": {
      const e = readEmail(raw);
      if (e) d.custom[f.key] = e;
      else warnings.push(issue(col, "EMAIL_INVALID", `${f.label}: not an email address. Left empty.`));
      return;
    }
    case "url": {
      const u = readUrl(raw);
      if (u) d.custom[f.key] = u;
      else warnings.push(issue(col, "URL_INVALID", `${f.label}: not a link. Left empty.`));
      return;
    }
    case "instagram": {
      const h = readInstagram(raw);
      if (h) d.custom[f.key] = h;
      else warnings.push(issue(col, "INSTAGRAM_INVALID", `${f.label}: not an Instagram handle. Left empty.`));
      return;
    }
    case "user": {
      const { person, ambiguous } = matchPerson(ctx, raw);
      if (ambiguous) problems.push(issue(col, "PERSON_AMBIGUOUS", `More than one person is called “${raw}”; use their email.`));
      else if (!person || !person.active) problems.push(issue(col, "PERSON_UNKNOWN", `No active person “${raw}”.`));
      else d.custom[f.key] = person.id;
      return;
    }
  }
}

/** Per mapped column: date order, decimal mark, and the values that don't match (with row counts). */
export function analyzeColumns(rows: string[][], m: Mapping, ctx: MapContext): ColumnAnalysis[] {
  return m.columns.map((c) => {
    const out: ColumnAnalysis = { column: c.column, unmatched: [] };
    if (c.to === "ignore" || c.to === "name_part") return out;
    const values = rows.map((r) => (r[c.column] ?? "").trim()).filter(Boolean);
    const type = c.to === "new_field" ? c.type : c.field === "lead_created_at" ? "date" : c.field === "value" ? "currency" : fieldOf(ctx, c.field)?.type;
    if (type && DATE_TYPES.has(type)) out.dateOrder = detectDateOrder(values);
    if (type && (MONEY_TYPES.has(type) || type === "number")) out.decimalMark = detectDecimalMark(values, defaultDecimalMark(ctx.country));
    if (c.to !== "field") return out;
    const counts = new Map<string, { value: string; rows: number }>();
    const note = (v: string) => {
      const k = fold(v);
      const e = counts.get(k) ?? { value: v, rows: 0 };
      e.rows++;
      counts.set(k, e);
    };
    const matches = (v: string): boolean => {
      const mv = viaMap(c, v);
      if (mv === null) return true;
      const x = mv ?? v;
      const f = fieldOf(ctx, c.field);
      switch (c.field) {
        case "stage":
          return ctx.stages.some((s) => fold(s.name) === fold(x));
        case "owner":
          return (() => {
            const { person, ambiguous } = matchPerson(ctx, x);
            return !ambiguous && !!person?.active;
          })();
        case "lost_reason":
          return ctx.lostReasons.some((l) => fold(l.label) === fold(x));
        default:
          if (!f) return true;
          if (f.type === "select")
            return f.options.some((o) => !o.archived && fold(o.label) === fold(x)) || (m.addOptions?.[c.field] ?? []).some((l) => fold(l) === fold(x));
          if (f.type === "boolean") return parseBoolean(x) !== null;
          if (f.type === "user") return !!matchPerson(ctx, x).person?.active;
          return true;
      }
    };
    for (const v of values) {
      if (c.field === "tags") {
        for (const part of v.split(splitter(c)).filter(Boolean))
          if (!ctx.tags.some((t) => fold(t.label) === fold(part))) note(part);
      } else if (fieldOf(ctx, c.field)?.type === "multi_select") {
        const f = fieldOf(ctx, c.field)!;
        for (const part of v.split(splitter(c)).filter(Boolean)) {
          const mv = viaMap(c, part);
          if (mv === null) continue;
          const label = mv ?? part;
          const known = f.options.some((o) => !o.archived && fold(o.label) === fold(label)) || (m.addOptions?.[c.field] ?? []).some((l) => fold(l) === fold(label));
          if (!known) note(part);
        }
      } else if (!matches(v)) note(v);
    }
    out.unmatched = [...counts.values()].sort((a, b) => b.rows - a.rows || a.value.localeCompare(b.value)).slice(0, 50);
    return out;
  });
}

/** Decides each column's date order and decimal mark; a conflicting date column must be chosen by the importer. */
export function resolveColumnSettings(analysis: ColumnAnalysis[], m: Mapping, ctx: Pick<MapContext, "country">) {
  const dateOrders: Record<number, DateOrder> = {};
  const decimalMarks: Record<number, "." | ","> = {};
  const blocking: Issue[] = [];
  for (const a of analysis) {
    const c = m.columns.find((x) => x.column === a.column);
    const chosen = c && c.to !== "ignore" ? c.transform?.dateOrder : undefined;
    if (a.dateOrder) {
      if (chosen) dateOrders[a.column] = chosen;
      else if (a.dateOrder === "conflict")
        blocking.push(issue(a.column, "DATE_ORDER_NEEDED", "This column has dates like 13/03 and 03/13 — choose how to read them."));
      else dateOrders[a.column] = a.dateOrder === "ambiguous" ? defaultDateOrder(ctx.country) : a.dateOrder;
    }
    if (a.decimalMark) decimalMarks[a.column] = a.decimalMark;
  }
  return { dateOrders, decimalMarks, blocking };
}
```

Add to `index.ts`: `export * from "./values"; export * from "./mapping"; export * from "./map-row";`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/core/src/intake'`
Expected: PASS for `read`, `values`, `mapping` and `map-row`. If `suggestMapping` maps "Mobile No." wrongly, check `clean()`: it must give `"mobile no"`, which is in `SYNONYMS`.

- [ ] **Step 7: Gate, commit, push**

```bash
bash "$G/gate.sh" > "$G/gate.log" 2>&1; tail -1 "$G/gate.log"
git add packages/core && git commit -m "feat(core): map a row to a lead — every rule of spec §6, with a reason for everything it refuses" && git push origin main
```

---

### Task 4: The intake tables

**Files:**
- Create: `packages/db/migrations/0015_intake.sql`, `packages/db/src/schema/intake.ts`, `packages/db/src/intake.test.ts`
- Modify: `packages/db/src/schema/index.ts` (`export * from "./intake";`), `packages/core/src/queues.ts` (add `"imports.run"` and `"imports.retention"`)

**Interfaces:**
- Produces Drizzle tables `leadSources`, `imports`, `importRows`, `importMappingMemory` (columns exactly as the SQL below, camel-cased), and queue names `imports.run`, `imports.retention`.

Access decision (spec amendment 5, recorded in the spec's §4.5): the intake tables are configuration-like, like `settings` and `field_definitions`. They have no row-level security; the API enforces §3's permissions on every route. What must never leak — who a merged lead belongs to — is protected by the *lead* tables' RLS, which the API consults when it describes a row. `lume_worker` gets exactly what the retention sweep needs and nothing else.

- [ ] **Step 1: Write the failing test** (`packages/db/src/intake.test.ts`)

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR_DEFAULT, migrate } from "./migrate";
import { installQueueSchema } from "./queue-install";
import { createTestDatabase, type TestDatabase } from "./testing";
import { QUEUE_NAMES } from "@lume/core";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
  await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
});
afterAll(async () => db.drop());

describe("0015_intake", () => {
  it("makes every row write-once per import", async () => {
    await db.query("lume_owner", `INSERT INTO lead_sources (id, type, name) VALUES ('00000000-0000-7000-8000-000000000001', 'csv', 'a.csv')`);
    await db.query("lume_owner", `INSERT INTO imports (id, source_id, kind, status, file_sha256, file_name, file_bytes, started_by)
      VALUES ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 'csv', 'draft', 'x', 'a.csv', 10, NULL)`);
    const row = `INSERT INTO import_rows (import_id, row_index, result) VALUES ('00000000-0000-7000-8000-000000000002', 2, 'created') ON CONFLICT (import_id, row_index) DO NOTHING RETURNING id`;
    expect((await db.query("lume_app", row)).rowCount).toBe(1);
    expect((await db.query("lume_app", row)).rowCount).toBe(0);
  });

  it("refuses a status or result outside the lists", async () => {
    await expect(db.query("lume_owner", `UPDATE imports SET status = 'nope'`)).rejects.toThrow(/imports_status/);
    await expect(db.query("lume_owner", `UPDATE import_rows SET result = 'nope'`)).rejects.toThrow(/import_rows_result/);
  });

  it("lets the worker clear old files and raw rows, and nothing else", async () => {
    await db.query("lume_worker", `UPDATE imports SET file_enc = NULL`);
    await db.query("lume_worker", `UPDATE import_rows SET raw_enc = NULL`);
    await expect(db.query("lume_worker", `UPDATE imports SET status = 'done'`)).rejects.toThrow(/permission denied/);
    await expect(db.query("lume_worker", `SELECT * FROM leads`)).rejects.toThrow(/permission denied/);
  });
});
```

(`TestDatabase.query(role, sql)` and `drop()` exist in `packages/db/src/testing.ts`; check the helper names there before running and adapt the three calls if they differ.)

- [ ] **Step 2: Run to see it fail**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/db/src/intake.test.ts'`
Expected: FAIL — `relation "lead_sources" does not exist`.

- [ ] **Step 3: Write the migration** (`packages/db/migrations/0015_intake.sql`)

```sql
-- Phase 2A intake (spec 2026-09-27 §4). Sources say where leads came from; an import is one run over a
-- file; every row of it gets one write-once result. Configuration-like: no RLS (the API enforces the
-- permissions); lume_worker may only clear old files and raw rows (retention), never read lead data.
CREATE TABLE lead_sources (
  id uuid PRIMARY KEY,
  type text NOT NULL CONSTRAINT lead_sources_type CHECK (type IN ('csv', 'google_sheet', 'webhook', 'manual')),
  name text NOT NULL,
  config_enc bytea,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CONSTRAINT lead_sources_status CHECK (status IN ('active', 'paused', 'needs_attention', 'archived')),
  last_synced_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE imports (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES lead_sources (id) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT imports_kind CHECK (kind IN ('csv')),
  status text NOT NULL CONSTRAINT imports_status CHECK (status IN ('draft', 'queued', 'running', 'cancelling', 'cancelled', 'stopped_access', 'failed', 'done')),
  file_enc bytea,
  file_sha256 text NOT NULL,
  file_name text NOT NULL,
  file_bytes integer NOT NULL,
  encoding text,
  delimiter text,
  header_row integer,
  headers jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  column_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursor_row integer NOT NULL DEFAULT 0,
  rr_cursor integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  created integer NOT NULL DEFAULT 0,
  merged integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  empty integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  warnings integer NOT NULL DEFAULT 0,
  name_from_contact integer NOT NULL DEFAULT 0,
  missing_stage_fields integer NOT NULL DEFAULT 0,
  phone_needs_country integer NOT NULL DEFAULT 0,
  started_by uuid REFERENCES users (id),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  seen_at timestamptz,
  stop_reason text,
  purged_at timestamptz
);
CREATE INDEX imports_recent ON imports (created_at DESC);
CREATE INDEX imports_sha ON imports (file_sha256) WHERE status = 'done';

CREATE TABLE import_rows (
  id bigserial PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES imports (id) ON DELETE CASCADE,
  row_index integer NOT NULL,
  fingerprint text,
  raw_enc bytea,
  result text NOT NULL CONSTRAINT import_rows_result CHECK (result IN ('pending', 'created', 'merged', 'skipped', 'error')),
  lead_id uuid,
  problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  also_matched uuid[] NOT NULL DEFAULT '{}',
  CONSTRAINT import_rows_once UNIQUE (import_id, row_index)
);
CREATE INDEX import_rows_by_result ON import_rows (import_id, result, row_index);

CREATE TABLE import_mapping_memory (
  header_signature text PRIMARY KEY,
  mapping jsonb NOT NULL,
  rules jsonb NOT NULL,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Default privileges gave lume_worker everything on new tables; take it back to retention only.
REVOKE ALL ON lead_sources, imports, import_rows, import_mapping_memory FROM lume_worker;
GRANT SELECT (id, source_id, status, finished_at, created_at, purged_at), UPDATE (file_enc, purged_at) ON imports TO lume_worker;
GRANT DELETE ON imports TO lume_worker;
GRANT SELECT (import_id), UPDATE (raw_enc) ON import_rows TO lume_worker;
GRANT SELECT (id), DELETE ON lead_sources TO lume_worker;
```

- [ ] **Step 4: Mirror it in Drizzle** (`packages/db/src/schema/intake.ts`)

```ts
import { sql } from "drizzle-orm";
import { bigserial, customType, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { tz } from "./types";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const leadSources = pgTable("lead_sources", {
  id: uuid("id").primaryKey(),
  type: text("type").$type<"csv" | "google_sheet" | "webhook" | "manual">().notNull(),
  name: text("name").notNull(),
  configEnc: bytea("config_enc"),
  mapping: jsonb("mapping").notNull().default(sql`'{}'::jsonb`),
  rules: jsonb("rules").notNull().default(sql`'{}'::jsonb`),
  status: text("status").$type<"active" | "paused" | "needs_attention" | "archived">().notNull().default("active"),
  lastSyncedAt: tz("last_synced_at"),
  lastError: text("last_error"),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
});

export type ImportStatus = "draft" | "queued" | "running" | "cancelling" | "cancelled" | "stopped_access" | "failed" | "done";

export const imports = pgTable("imports", {
  id: uuid("id").primaryKey(),
  sourceId: uuid("source_id").notNull(),
  kind: text("kind").$type<"csv">().notNull(),
  status: text("status").$type<ImportStatus>().notNull(),
  fileEnc: bytea("file_enc"),
  fileSha256: text("file_sha256").notNull(),
  fileName: text("file_name").notNull(),
  fileBytes: integer("file_bytes").notNull(),
  encoding: text("encoding"),
  delimiter: text("delimiter"),
  headerRow: integer("header_row"),
  headers: jsonb("headers").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  rowCount: integer("row_count").notNull().default(0),
  mapping: jsonb("mapping").notNull().default(sql`'{}'::jsonb`),
  rules: jsonb("rules").notNull().default(sql`'{}'::jsonb`),
  columnSettings: jsonb("column_settings").notNull().default(sql`'{}'::jsonb`),
  cursorRow: integer("cursor_row").notNull().default(0),
  rrCursor: integer("rr_cursor").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  created: integer("created").notNull().default(0),
  merged: integer("merged").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  empty: integer("empty").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  warnings: integer("warnings").notNull().default(0),
  nameFromContact: integer("name_from_contact").notNull().default(0),
  missingStageFields: integer("missing_stage_fields").notNull().default(0),
  phoneNeedsCountry: integer("phone_needs_country").notNull().default(0),
  startedBy: uuid("started_by"),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  startedAt: tz("started_at"),
  finishedAt: tz("finished_at"),
  seenAt: tz("seen_at"),
  stopReason: text("stop_reason"),
  purgedAt: tz("purged_at"),
});

export const importRows = pgTable(
  "import_rows",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    importId: uuid("import_id").notNull(),
    rowIndex: integer("row_index").notNull(),
    fingerprint: text("fingerprint"),
    rawEnc: bytea("raw_enc"),
    result: text("result").$type<"pending" | "created" | "merged" | "skipped" | "error">().notNull(),
    leadId: uuid("lead_id"),
    problems: jsonb("problems").$type<{ column: number | null; code: string; message: string }[]>().notNull().default(sql`'[]'::jsonb`),
    warnings: jsonb("warnings").$type<{ column: number | null; code: string; message: string }[]>().notNull().default(sql`'[]'::jsonb`),
    alsoMatched: uuid("also_matched").array().notNull().default(sql`'{}'`),
  },
  (t) => [unique("import_rows_once").on(t.importId, t.rowIndex)],
);

export const importMappingMemory = pgTable("import_mapping_memory", {
  headerSignature: text("header_signature").primaryKey(),
  mapping: jsonb("mapping").notNull(),
  rules: jsonb("rules").notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});
```

In `packages/core/src/queues.ts`:
```ts
export const QUEUE_NAMES = ["ops.backup", "ops.restore-test", "ops.idempotency-cleanup", "imports.run", "imports.retention"] as const;
```

- [ ] **Step 4b: Record amendment 5 in the spec** — replace spec §4.5's body with the access decision above (no RLS on intake tables; API enforces §3; worker limited to retention columns), and §4.6's "nightly maintenance step" stays.

- [ ] **Step 5: Run to see it pass, plus the schema drift test**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run packages/db'`
Expected: PASS, including `schema.drift.test.ts` (Drizzle matches the SQL). If the drift test flags a default's spelling, copy the SQL's exact default into the Drizzle column.

- [ ] **Step 6: Gate, commit, push**

```bash
bash "$G/gate.sh" > "$G/gate.log" 2>&1; tail -1 "$G/gate.log"
git add packages docs/superpowers/specs && git commit -m "feat(db): lead sources, imports and write-once import rows" && git push origin main
```

---

### Task 5: One lead-writing path, and a request-shaped facade for jobs

**Files:**
- Create: `apps/api/src/modules/leads/writer.ts`, `apps/api/src/modules/leads/writer.test.ts`, `apps/api/src/modules/imports/job-request.ts`, `apps/api/src/modules/imports/job-request.test.ts`
- Modify: `apps/api/src/modules/leads/service.ts` (`createLead` uses `insertLead`)

**Interfaces:**
- Consumes: `schema` from `@lume/db`; `recordActivity`, `LeadRow` from the leads module; `applyRequestScope` from `apps/api/src/db/context.ts`; `ActorRecord` from `rbac/actor`.
- Produces:
  ```ts
  // writer.ts
  export type NewLead = {
    pipelineId: string; stageId: string; ownerId: string | null; name: string;
    contact: { phoneRaw: string | null; phoneE164: string | null; phoneCountryIso: string | null; phoneStatus: "valid" | "needs_country" | "invalid" | "missing"; email: string | null; instagramHandle: string | null };
    value: number | null; productId: string | null; leadCreatedAt: string | null; custom: Record<string, unknown>;
    tagIds: string[]; sourceId: string | null; lostReasonId: string | null; closedAt: Date | null; // won_at/lost_at by the stage's kind
    stageKind: "open" | "won" | "lost"; stageEnteredAt: Date; activity: { type: string; payload: Record<string, unknown> };
    assignReason: "created" | "imported";
  };
  export async function insertLead(req: FastifyRequest, lead: NewLead): Promise<string>;           // returns the new id; writes lead, tags, stage + assignment history, the activity
  export type MergeFill = { name?: never; phone?: NewLead["contact"]; email?: string; instagram?: string; value?: number; leadCreatedAt?: string; ownerId?: string; custom?: Record<string, unknown>; tagIds?: string[]; reopenTo?: { stageId: string } };
  export function mergeFill(lead: LeadRow, draft: { contact: NewLead["contact"]; value: number | null; leadCreatedAt: string | null; ownerId: string | null; custom: Record<string, unknown>; tagIds: string[] }, existingTagIds: string[], reopenTo: string | null): { fill: MergeFill; filled: string[] };
  export async function mergeIntoLead(req: FastifyRequest, lead: LeadRow, fill: MergeFill, activity: { type: string; payload: Record<string, unknown> }): Promise<void>;
  // job-request.ts
  export async function withJobRequest<T>(o: { app: FastifyInstance; pool: pg.Pool; actor: ActorRecord; requestId: string; allLeads: boolean }, fn: (req: FastifyRequest) => Promise<T>): Promise<T>;
  ```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/leads/writer.test.ts` — `mergeFill` is pure; test it directly:

```ts
import { describe, expect, it } from "vitest";
import { mergeFill } from "./writer";
import type { LeadRow } from "./serialize";

const lead = (over: Partial<LeadRow> = {}): LeadRow =>
  ({
    id: "l1", pipelineId: "p1", stageId: "s-new", ownerId: null, name: "Aisha", phoneRaw: null, phoneE164: null, phoneCountryIso: null,
    phoneStatus: "missing", email: "a@x.com", instagramHandle: null, value: null, leadCreatedAt: "2026-01-02", custom: { tier: "o-gold" },
    wonAt: null, lostAt: null, version: 3,
    ...over,
  }) as LeadRow;
const contact = { phoneRaw: "0501234567", phoneE164: "+971501234567", phoneCountryIso: "AE", phoneStatus: "valid" as const, email: "b@x.com", instagramHandle: "aisha" };
const draft = { contact, value: 4500, leadCreatedAt: "2025-12-01", ownerId: "u-riya", custom: { tier: "o-silver", paid: true }, tagIds: ["t-vip"] };

describe("mergeFill (spec §6.9)", () => {
  it("fills only what's empty, and never overwrites what the team typed", () => {
    const { fill, filled } = mergeFill(lead(), draft, ["t-hot"], null);
    expect(fill.phone).toEqual(contact);
    expect(fill.email).toBeUndefined(); // the lead already has one
    expect(fill.instagram).toBe("aisha");
    expect(fill.value).toBe(4500);
    expect(fill.leadCreatedAt).toBeUndefined(); // the first appearance stays the origin
    expect(fill.ownerId).toBe("u-riya"); // unassigned counts as empty
    expect(fill.custom).toEqual({ paid: true }); // tier kept
    expect(fill.tagIds).toEqual(["t-vip"]); // added to t-hot, not replacing it
    expect(filled).toEqual(["phone", "instagram", "value", "owner", "paid", "tags"]);
  });

  it("keeps an existing phone even when it's unreadable (the bulk fix handles those)", () => {
    const { fill } = mergeFill(lead({ phoneRaw: "0501", phoneStatus: "invalid" }), draft, [], null);
    expect(fill.phone).toBeUndefined();
  });

  it("never changes an existing owner", () => {
    expect(mergeFill(lead({ ownerId: "u-tas" }), draft, [], null).fill.ownerId).toBeUndefined();
  });

  it("reopens a closed lead only when asked, and only a closed one", () => {
    expect(mergeFill(lead({ lostAt: new Date() }), draft, [], "s-new").fill.reopenTo).toEqual({ stageId: "s-new" });
    expect(mergeFill(lead(), draft, [], "s-new").fill.reopenTo).toBeUndefined();
    expect(mergeFill(lead({ wonAt: new Date() }), draft, [], null).fill.reopenTo).toBeUndefined();
  });

  it("treats an empty list or empty string as empty", () => {
    const { fill } = mergeFill(lead({ custom: { struggles: [], note: "" } }), { ...draft, custom: { struggles: ["o-conf"], note: "hi" } }, [], null);
    expect(fill.custom).toEqual({ struggles: ["o-conf"], note: "hi" });
  });
});
```

`apps/api/src/modules/imports/job-request.test.ts` — against a real database, through the harness:

```ts
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { withJobRequest } from "./job-request";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
});
afterAll(async () => h.close());

describe("withJobRequest", () => {
  it("runs as the actor, sees every lead when asked, and commits", async () => {
    const rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const other = await h.seedUser({ grants: ALL_GRANTS });
    const leadId = await h.seedLead({ name: "Someone else's", ownerId: other.id });
    const actor = (await h.app.actorCache.get(rep.id))!;
    const seen = await withJobRequest({ app: h.app, pool: h.pool, actor, requestId: "t1", allLeads: true }, async (req) =>
      (await req.db.execute(`SELECT id FROM leads WHERE id = '${leadId}'`)).rows.length,
    );
    expect(seen).toBe(1);
    const narrow = await withJobRequest({ app: h.app, pool: h.pool, actor, requestId: "t2", allLeads: false }, async (req) =>
      (await req.db.execute(`SELECT id FROM leads WHERE id = '${leadId}'`)).rows.length,
    );
    expect(narrow).toBe(0);
  });

  it("rolls back when the work throws", async () => {
    const admin = await h.seedUser({ grants: ALL_GRANTS });
    const actor = (await h.app.actorCache.get(admin.id))!;
    await expect(
      withJobRequest({ app: h.app, pool: h.pool, actor, requestId: "t3", allLeads: true }, async (req) => {
        await req.db.execute(`INSERT INTO lead_sources (id, type, name) VALUES ('00000000-0000-7000-8000-00000000abcd', 'csv', 'x')`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await h.pool.query(`SELECT 1 FROM lead_sources WHERE id = '00000000-0000-7000-8000-00000000abcd'`)).rowCount).toBe(0);
  });
});
```

(The harness already exposes `app`, `pool`, `seedUser` and `seedLead`; if `app` isn't on `Harness`, add `app: FastifyInstance` to its returned object — it's built there.)

- [ ] **Step 2: Run to see them fail**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/modules/leads/writer.test.ts apps/api/src/modules/imports/job-request.test.ts'`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `writer.ts`**

```ts
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { newId } from "@lume/core";
import { schema } from "@lume/db";
import type { LeadRow } from "./serialize";
import { recordActivity } from "./service";

const L = schema.leads;

export type NewLead = {
  pipelineId: string;
  stageId: string;
  ownerId: string | null;
  name: string;
  contact: {
    phoneRaw: string | null; phoneE164: string | null; phoneCountryIso: string | null;
    phoneStatus: "valid" | "needs_country" | "invalid" | "missing"; email: string | null; instagramHandle: string | null;
  };
  value: number | null;
  productId: string | null;
  leadCreatedAt: string | null;
  custom: Record<string, unknown>;
  tagIds: string[];
  sourceId: string | null;
  lostReasonId: string | null;
  closedAt: Date | null;
  stageKind: "open" | "won" | "lost";
  stageEnteredAt: Date;
  activity: { type: string; payload: Record<string, unknown> };
  assignReason: "created" | "imported";
};

/** The one path that creates a lead: the lead, its tags, its first stage and owner in history, and its first activity. */
export async function insertLead(req: FastifyRequest, lead: NewLead): Promise<string> {
  const id = newId();
  const actorId = req.actor!.userId;
  await req.db.insert(L).values({
    id,
    pipelineId: lead.pipelineId,
    stageId: lead.stageId,
    ownerId: lead.ownerId,
    name: lead.name,
    ...lead.contact,
    value: lead.value,
    currency: null, // always the business currency
    productId: lead.productId,
    leadCreatedAt: lead.leadCreatedAt,
    custom: Object.fromEntries(Object.entries(lead.custom).filter(([, v]) => v !== null && v !== undefined)),
    sourceId: lead.sourceId,
    lostReasonId: lead.stageKind === "lost" ? lead.lostReasonId : null,
    wonAt: lead.stageKind === "won" ? lead.closedAt : null,
    lostAt: lead.stageKind === "lost" ? lead.closedAt : null,
    createdBy: actorId,
    lastActivityAt: new Date(),
    stageEnteredAt: lead.stageEnteredAt,
  });
  if (lead.tagIds.length)
    await req.db.insert(schema.leadTags).values([...new Set(lead.tagIds)].map((tagId) => ({ leadId: id, tagId })));
  await req.db
    .insert(schema.leadStageHistory)
    .values({ leadId: id, fromStageId: null, toStageId: lead.stageId, pipelineId: lead.pipelineId, changedBy: actorId });
  if (lead.ownerId)
    await req.db.insert(schema.leadAssignmentHistory).values({
      leadId: id, fromUserId: null, toUserId: lead.ownerId, changedBy: actorId, reason: lead.assignReason,
    });
  await recordActivity(req, id, lead.activity.type, lead.activity.payload);
  return id;
}

export type MergeFill = {
  phone?: NewLead["contact"];
  email?: string;
  instagram?: string;
  value?: number;
  leadCreatedAt?: string;
  ownerId?: string;
  custom?: Record<string, unknown>;
  tagIds?: string[];
  reopenTo?: { stageId: string };
};

const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Spec §6.9: what a merge fills — only empty fields; never the name, an existing phone, owner or origin date. */
export function mergeFill(
  lead: LeadRow,
  draft: { contact: NewLead["contact"]; value: number | null; leadCreatedAt: string | null; ownerId: string | null; custom: Record<string, unknown>; tagIds: string[] },
  existingTagIds: string[],
  reopenTo: string | null,
): { fill: MergeFill; filled: string[] } {
  const fill: MergeFill = {};
  const filled: string[] = [];
  if (lead.phoneStatus === "missing" && draft.contact.phoneStatus !== "missing") {
    fill.phone = draft.contact;
    filled.push("phone");
  }
  if (empty(lead.email) && draft.contact.email) {
    fill.email = draft.contact.email;
    filled.push("email");
  }
  if (empty(lead.instagramHandle) && draft.contact.instagramHandle) {
    fill.instagram = draft.contact.instagramHandle;
    filled.push("instagram");
  }
  if (lead.value === null && draft.value !== null) {
    fill.value = draft.value;
    filled.push("value");
  }
  if (lead.leadCreatedAt === null && draft.leadCreatedAt) {
    fill.leadCreatedAt = draft.leadCreatedAt;
    filled.push("date");
  }
  if (lead.ownerId === null && draft.ownerId) {
    fill.ownerId = draft.ownerId;
    filled.push("owner");
  }
  const custom: Record<string, unknown> = {};
  const current = (lead.custom ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(draft.custom))
    if (!empty(v) && empty(current[k])) {
      custom[k] = v;
      filled.push(k);
    }
  if (Object.keys(custom).length) fill.custom = custom;
  const newTags = draft.tagIds.filter((t) => !existingTagIds.includes(t));
  if (newTags.length) {
    fill.tagIds = newTags;
    filled.push("tags");
  }
  if (reopenTo && (lead.wonAt || lead.lostAt)) fill.reopenTo = { stageId: reopenTo };
  return { fill, filled };
}

/** Applies a merge: one update (version + 1), the new tags, a reopen with its stage history, and the activity. */
export async function mergeIntoLead(req: FastifyRequest, lead: LeadRow, fill: MergeFill, activity: { type: string; payload: Record<string, unknown> }) {
  const actorId = req.actor!.userId;
  const set: Record<string, unknown> = { version: sql`${L.version} + 1`, updatedAt: new Date(), lastActivityAt: new Date() };
  if (fill.phone) Object.assign(set, { phoneRaw: fill.phone.phoneRaw, phoneE164: fill.phone.phoneE164, phoneCountryIso: fill.phone.phoneCountryIso, phoneStatus: fill.phone.phoneStatus });
  if (fill.email) set.email = fill.email;
  if (fill.instagram) set.instagramHandle = fill.instagram;
  if (fill.value !== undefined) set.value = fill.value;
  if (fill.leadCreatedAt) set.leadCreatedAt = fill.leadCreatedAt;
  if (fill.ownerId) set.ownerId = fill.ownerId;
  if (fill.custom) set.custom = sql`${L.custom} || ${JSON.stringify(fill.custom)}::jsonb`;
  if (fill.reopenTo) Object.assign(set, { stageId: fill.reopenTo.stageId, wonAt: null, lostAt: null, lostReasonId: null, stageEnteredAt: new Date() });
  await req.db.update(L).set(set).where(eq(L.id, lead.id));
  if (fill.tagIds?.length)
    await req.db.insert(schema.leadTags).values(fill.tagIds.map((tagId) => ({ leadId: lead.id, tagId }))).onConflictDoNothing();
  if (fill.ownerId)
    await req.db.insert(schema.leadAssignmentHistory).values({ leadId: lead.id, fromUserId: null, toUserId: fill.ownerId, changedBy: actorId, reason: "imported" });
  if (fill.reopenTo)
    await req.db.insert(schema.leadStageHistory).values({ leadId: lead.id, fromStageId: lead.stageId, toStageId: fill.reopenTo.stageId, pipelineId: lead.pipelineId, changedBy: actorId });
  await recordActivity(req, lead.id, activity.type, activity.payload);
}
```

Then, in `service.ts`, replace `createLead`'s body from `const id = newId();` through the `recordActivity(...)` call with:

```ts
  const stageKind = await stageKindOf(req, stageId);
  const now = new Date();
  const id = await insertLead(req, {
    pipelineId, stageId, ownerId, name: input.name,
    contact: {
      phoneRaw: contact.phoneRaw ?? null, phoneE164: contact.phoneE164 ?? null, phoneCountryIso: contact.phoneCountryIso ?? null,
      phoneStatus: contact.phoneStatus ?? "missing", email: contact.email ?? null, instagramHandle: contact.instagramHandle ?? null,
    },
    value: input.value ?? null, productId: input.productId ?? null, leadCreatedAt: input.leadCreatedAt ?? null,
    custom, tagIds: input.tagIds ?? [], sourceId: null, lostReasonId: null, closedAt: stageKind === "open" ? null : now,
    stageKind, stageEnteredAt: now, activity: { type: "lead_created", payload: { source: "manual" } }, assignReason: "created",
  });
```

and add beside `resolveStage`:

```ts
async function stageKindOf(req: FastifyRequest, stageId: string): Promise<"open" | "won" | "lost"> {
  const [s] = await req.db.select({ kind: schema.stages.kind }).from(schema.stages).where(eq(schema.stages.id, stageId));
  return s?.kind ?? "open";
}
```

(Hand-made leads keep their current behaviour exactly; the existing leads tests prove it. `setTags` is no longer used by `createLead` — keep it for `updateLead`.)

- [ ] **Step 4: Implement `job-request.ts`**

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { schema } from "@lume/db";
import { applyRequestScope } from "../../db/context";
import type { ActorRecord } from "../../rbac/actor";

/**
 * One transaction that looks like a request to the service code (db, actor, server, id, ip), so a job
 * writes leads through exactly the same functions a person does. `allLeads` widens lead_scope to 'all'
 * for this transaction only (the duplicate check must see every lead); everything else stays the actor's.
 */
export async function withJobRequest<T>(
  o: { app: FastifyInstance; pool: pg.Pool; actor: ActorRecord; requestId: string; allLeads: boolean },
  fn: (req: FastifyRequest) => Promise<T>,
): Promise<T> {
  const client = await o.pool.connect();
  const after: (() => void)[] = [];
  try {
    await client.query("BEGIN");
    await applyRequestScope(client, o.actor);
    if (o.allLeads) await client.query("SELECT set_config('lume.lead_scope', 'all', true)");
    const req = {
      db: drizzle(client, { schema }),
      actor: o.actor,
      server: o.app,
      id: o.requestId,
      ip: null,
      log: o.app.log,
      afterCommit: (f: () => void) => void after.push(f),
      beforeCommit: () => {
        throw new Error("beforeCommit isn't available in a job");
      },
    } as unknown as FastifyRequest;
    const out = await fn(req);
    await client.query("COMMIT");
    client.release();
    for (const f of after) f();
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw e;
  }
}
```

- [ ] **Step 5: Run the new tests and the whole leads suite**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/modules/leads apps/api/src/modules/imports'`
Expected: PASS — including every existing `leads.test.ts` case (hand-made creation unchanged).

- [ ] **Step 6: Gate, commit, push**

```bash
bash "$G/gate.sh" > "$G/gate.log" 2>&1; tail -1 "$G/gate.log"
git add apps/api && git commit -m "refactor(api): one lead-writing path for people and jobs, and a request-shaped job transaction" && git push origin main
```

---

### Task 6: Drafts — upload, settings, preview, list and discard

**Files:**
- Create: `apps/api/src/modules/imports/context.ts`, `apps/api/src/modules/imports/files.ts`, `apps/api/src/modules/imports/service.ts`, `apps/api/src/modules/imports/routes.ts`, `apps/api/src/modules/imports/imports.test.ts`
- Modify: `apps/api/src/app.ts` (register `importRoutes(scope, deps)` beside the other modules), `apps/api/test/probes.ts`

**Interfaces:**
- Consumes: `readCsv`, `suggestMapping`, `validateMapping`, `analyzeColumns`, `resolveColumnSettings`, `mapRow`, `DEFAULT_RULES`, `MAPPABLE_TARGETS`, `INTAKE_LIMITS` (Tasks 1–3); `withJobRequest` (Task 5); `contactKeyHash` from `@lume/db`; `can`, `fieldAccessOf` from `@lume/core`; `AppDeps.keyring`.
- Produces:
  ```ts
  // files.ts
  export function sealFile(keyring: Keyring, importId: string, bytes: Buffer): Buffer;
  export function openFile(keyring: Keyring, importId: string, sealed: Buffer): Buffer;
  export function readImportFile(keyring: Keyring, imp: ImportRow): ReadCsv;   // throws 409 FILE_PURGED when file_enc is null
  // context.ts
  export async function loadMapContext(req: FastifyRequest, o: { pipelineId: string; headerCount: number; columnSettings?: { dateOrders: Record<number, DateOrder>; decimalMarks: Record<number, "." | ","> }; pending?: Mapping }): Promise<MapContext & { stagesFull: { id: string; name: string; kind: "open" | "won" | "lost"; requiredFieldIds: string[] }[] }>;
  export async function findMatches(req: FastifyRequest, draft: LeadDraft, matchOn: Rules["matchOn"]): Promise<{ leadId: string; kind: "phone" | "email" | "instagram" }[]>; // needs a transaction with lead_scope 'all'; excludes deleted leads; ordered by matchOn priority, then most recently active
  // service.ts
  export type DraftView = { id: string; status: ImportStatus; fileName: string; fileBytes: number; encoding: Encoding; delimiter: Delimiter; headerRow: number; headers: string[]; sample: string[][]; rowCount: number; fileWarnings: FileWarning[]; mapping: Mapping; rules: Rules; targets: ReturnType<typeof MAPPABLE_TARGETS>; analysis: ColumnAnalysis[]; problems: Issue[]; alreadyImported: { at: string; by: string | null } | null; choices: { pipelines: { id: string; name: string; isDefault: boolean }[]; stages: { id: string; name: string; kind: string }[]; people: { id: string; name: string; email: string }[]; fields: IntakeField[] }; can: { assign: boolean; manageFields: boolean; manageTags: boolean } };
  export type PreviewRow = { rowNumber: number; outcome: "create" | "merge" | "skip" | "error" | "empty"; name: string | null; mergeInto: { visible: true; leadId: string; name: string; ownerName: string | null } | { visible: false } | { row: number } | null; alsoMatches: number; problems: Issue[]; warnings: Issue[] };
  export async function uploadImport(req, d, bytes: Buffer, fileName: string): Promise<DraftView>;
  export async function patchImport(req, d, id: string, patch: { encoding?; delimiter?; headerRow?; mapping?; rules? }): Promise<DraftView>;
  export async function previewImport(req, d, id: string, o?: { rows?: number[]; errorsOnly?: boolean }): Promise<{ rows: PreviewRow[]; summary: Record<PreviewRow["outcome"], number>; scanned: number }>;
  export async function getDraft(req, d, id: string): Promise<DraftView>; // 409 NOT_DRAFT once started
  export async function discardImport(req, d, id: string): Promise<void>;
  export async function listImports(req, cursor?: string): Promise<{ imports: ImportView[]; nextCursor: string | null }>;
  export async function getImport(req, id: string): Promise<ImportView>;
  export type ImportView = { id: string; status: ImportStatus; fileName: string; rowCount: number; cursorRow: number; counts: { created: number; merged: number; skipped: number; empty: number; errors: number; warnings: number; nameFromContact: number; missingStageFields: number; phoneNeedsCountry: number }; startedBy: { id: string; name: string } | null; createdAt: string; startedAt: string | null; finishedAt: string | null; seenAt: string | null; stopReason: string | null; sourceId: string; canSeeRows: boolean; mine: boolean };
  ```
- Routes (all `permission: "leads.import"`): `POST /api/v1/imports` (octet-stream, `idempotent: false`, `bodyLimit` 10 MB + 1), `GET /api/v1/imports/:id/draft`, `PATCH /api/v1/imports/:id`, `POST /api/v1/imports/:id/preview` (`{ rows?, errorsOnly? }`), `DELETE /api/v1/imports/:id`, `GET /api/v1/imports`, `GET /api/v1/imports/:id`.

Rules decided here, from the spec:
- **A draft belongs to whoever uploaded it.** Other holders of `leads.import` get `404` for someone else's draft. They see started imports in the list, with counts only.
- **Changing the header row re-suggests the mapping**, because the columns changed. Changing the encoding or delimiter keeps the mapping if the header count is unchanged, else re-suggests.
- **The default pipeline and its first open stage** are the rules' defaults. Remembered rules (§4.4) apply only while their pipeline and stages still exist.
- **Preview runs in two transactions:** the request's own, as the importer, which decides what the importer may see, and one `withJobRequest(allLeads: true)`, which finds matches among every lead. That's spec §6.11.

- [ ] **Step 1: Write the failing tests** (`apps/api/src/modules/imports/imports.test.ts`)

```ts
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
const csv = (s: string) => Buffer.from(s, "utf8");
const upload = (c: AuthedClient, body: Buffer, name = "leads.csv") =>
  c.inject({ method: "POST", url: "/api/v1/imports", payload: body, headers: { "content-type": "application/octet-stream", "x-file-name": name } });

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("upload", () => {
  it("reads the file, suggests a mapping and default rules, and keeps the file sealed", async () => {
    const r = await upload(admin, csv("Full name,Mobile,Email\nAisha Khan,050 123 4567,a@x.com\n"));
    expect(r.statusCode, r.body).toBe(201);
    const d = r.json();
    expect(d).toMatchObject({ status: "draft", fileName: "leads.csv", rowCount: 1, encoding: "utf-8", delimiter: ",", headerRow: 1 });
    expect(d.mapping.columns.map((c: { field?: string }) => c.field)).toEqual(["name", "phone", "email"]);
    expect(d.rules).toMatchObject({ onMatch: "merge", noName: "use_contact" });
    const row = (await h.pool.query("SELECT file_enc FROM imports WHERE id = $1", [d.id])).rows[0];
    expect(row.file_enc.toString("utf8")).not.toContain("Aisha"); // encrypted at rest
  });

  it("refuses unreadable files with a specific code", async () => {
    expect((await upload(admin, csv(""))).json().error.code).toBe("FILE_EMPTY");
    expect((await upload(admin, csv("a,b\n1,2\n"), "leads.xlsx")).json().error.code).toBe("NOT_CSV_EXCEL");
    const big = await upload(admin, Buffer.alloc(10_485_761, 0x41));
    expect([400, 413]).toContain(big.statusCode);
  });

  it("warns when the same file was imported before", async () => {
    const body = csv("Name\nOnce\n");
    const first = (await upload(admin, body)).json();
    await h.pool.query("UPDATE imports SET status = 'done', finished_at = now(), started_by = created_by WHERE id = $1", [first.id]);
    expect((await upload(admin, body)).json().alreadyImported).toMatchObject({ by: expect.any(String) });
  });

  it("needs Import leads", async () => {
    const rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] }));
    expect((await upload(rep, csv("Name\nA\n"))).statusCode).toBe(403);
  });
});

describe("settings and preview", () => {
  it("re-reads the file when the header row changes, and re-suggests the mapping", async () => {
    const d = (await upload(admin, csv("Export of March\nName,Phone\nA,0501234567\n"))).json();
    expect(d.headerRow).toBe(2);
    const p = (await admin.inject({ method: "PATCH", url: `/api/v1/imports/${d.id}`, payload: { headerRow: 1 } })).json();
    expect(p.headers).toEqual(["Export of March"]);
    expect(p.mapping.columns.map((c: { to: string }) => c.to)).toEqual(["ignore"]);
  });

  it("previews the first rows: create, merge into a visible lead, repeats within the file, errors", async () => {
    const owner = await h.seedUser({ grants: ALL_GRANTS, name: "Leila Haddad" });
    await h.seedLead({ name: "Already Here", ownerId: owner.id, phone: "+971501112222" });
    const d = (await upload(admin, csv("Name,Phone,Stage\nNew Person,0503334444,New\nAgain,050 111 2222,New\nTwice,0503334444,New\nBad,0505556666,Proposal Sent\n,,\n"))).json();
    const p = (await admin.inject({ method: "POST", url: `/api/v1/imports/${d.id}/preview`, payload: {} })).json();
    expect(p.rows.map((r: { outcome: string }) => r.outcome)).toEqual(["create", "merge", "merge", "error", "empty"]);
    expect(p.rows[1].mergeInto).toMatchObject({ visible: true, name: "Already Here", ownerName: "Leila Haddad" });
    expect(p.rows[2].mergeInto).toEqual({ row: 2 }); // the first "New Person" row
    expect(p.rows[3].problems[0].code).toBe("STAGE_UNKNOWN");
    expect(p.summary).toMatchObject({ create: 1, merge: 2, error: 1, empty: 1 });
  });

  it("Review Focus 5: a merge into a lead the importer can't see stays anonymous", async () => {
    const importer = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }, { key: "leads.create", scope: null }, { key: "leads.import", scope: null }] }));
    const other = await h.seedUser({ grants: ALL_GRANTS, name: "Someone Else" });
    await h.seedLead({ name: "Private Lead", ownerId: other.id, phone: "+971507778888" });
    const d = (await upload(importer, csv("Name,Phone\nX,0507778888\n"))).json();
    const p = (await importer.inject({ method: "POST", url: `/api/v1/imports/${d.id}/preview`, payload: {} })).json();
    expect(p.rows[0]).toMatchObject({ outcome: "merge", mergeInto: { visible: false } });
    expect(JSON.stringify(p)).not.toContain("Private Lead");
    expect(JSON.stringify(p)).not.toContain("Someone Else");
  });

  it("shows unmatched values per column and blocks on a date column it can't read", async () => {
    const d = (await upload(admin, csv("Name,Date,Stage\nA,13/03/2026,Hot lead\nB,03/13/2026,Hot lead\n"))).json();
    expect(d.analysis[2].unmatched).toEqual([{ value: "Hot lead", rows: 2 }]);
    expect(d.problems.map((p: { code: string }) => p.code)).toContain("DATE_ORDER_NEEDED");
  });

  it("keeps a draft to the person who uploaded it", async () => {
    const d = (await upload(admin, csv("Name\nA\n"))).json();
    const other = await h.signIn(await h.seedUser({ grants: ALL_GRANTS }));
    expect((await other.inject({ method: "GET", url: `/api/v1/imports/${d.id}` })).statusCode).toBe(404);
    expect((await other.inject({ method: "DELETE", url: `/api/v1/imports/${d.id}` })).statusCode).toBe(404);
    expect((await admin.inject({ method: "DELETE", url: `/api/v1/imports/${d.id}` })).statusCode).toBe(204);
  });
});
```

Add each route to `apps/api/test/probes.ts` (their `access` is `leads.import`; bodies can be the minimal valid shape, and an `imports` fixture id is created in the probes' setup the same way the lost-reason fixtures are).

- [ ] **Step 2: Run to see them fail**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/modules/imports/imports.test.ts'`
Expected: FAIL — 404 on `/api/v1/imports`.

- [ ] **Step 3: Implement `files.ts`**

```ts
import type { Keyring } from "@lume/core";
import { readCsv, type ReadCsv } from "@lume/core";
import type { schema } from "@lume/db";
import { HttpError } from "../../http/errors";

type ImportRow = typeof schema.imports.$inferSelect;
const context = (id: string) => `import-file:${id}`;

export const sealFile = (keyring: Keyring, importId: string, bytes: Buffer): Buffer =>
  keyring.encrypt(bytes.toString("base64"), context(importId));
export const openFile = (keyring: Keyring, importId: string, sealed: Buffer): Buffer =>
  Buffer.from(keyring.decrypt(sealed, context(importId)), "base64");

export function readImportFile(keyring: Keyring, imp: ImportRow): ReadCsv {
  if (!imp.fileEnc) throw new HttpError(409, "FILE_PURGED", "This import's file was removed after 30 days.");
  const r = readCsv(openFile(keyring, imp.id, imp.fileEnc), {
    fileName: imp.fileName,
    encoding: (imp.encoding ?? undefined) as never,
    delimiter: (imp.delimiter ?? undefined) as never,
    headerRow: imp.headerRow ?? undefined,
  });
  if (!r.ok) throw new HttpError(400, r.code, r.message);
  return r;
}
```

- [ ] **Step 4: Implement `context.ts`**

```ts
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, fieldAccessOf, type DateOrder, type IntakeField, type LeadDraft, type MapContext, type Mapping, type Rules } from "@lume/core";
import { contactKeyHash, schema } from "@lume/db";

const todayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** Everything a row is checked against, for this importer, now. `pending` adds options and tags chosen to be created at Start, so the preview treats them as real. */
export async function loadMapContext(
  req: FastifyRequest,
  o: { pipelineId: string; headerCount: number; columnSettings?: { dateOrders: Record<number, DateOrder>; decimalMarks: Record<number, "." | ","> }; pending?: Mapping },
) {
  const actor = req.actor!;
  const [settings] = await req.db.select().from(schema.settings).where(eq(schema.settings.id, 1));
  const defs = await req.db.select().from(schema.fieldDefinitions).orderBy(asc(schema.fieldDefinitions.position));
  const stagesFull = (
    await req.db
      .select({ id: schema.stages.id, name: schema.stages.name, kind: schema.stages.kind, requiredFieldIds: schema.stages.requiredFieldIds })
      .from(schema.stages)
      .where(and(eq(schema.stages.pipelineId, o.pipelineId), isNull(schema.stages.archivedAt)))
      .orderBy(asc(schema.stages.position))
  ).map((s) => ({ ...s, requiredFieldIds: s.requiredFieldIds ?? [] }));
  const people = await req.db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, status: schema.users.status }).from(schema.users);
  const tags = await req.db.select({ id: schema.tags.id, label: schema.tags.label }).from(schema.tags);
  const reasons = await req.db
    .select({ id: schema.lostReasons.id, label: schema.lostReasons.label })
    .from(schema.lostReasons)
    .where(isNull(schema.lostReasons.archivedAt));
  const fields: IntakeField[] = defs.map((f) => {
    const extra = o.pending?.addOptions?.[f.key] ?? [];
    return {
      id: f.id, key: f.key, label: f.label, type: f.type, isCore: f.isCore, isRequired: f.isRequired, archived: f.archivedAt !== null,
      access: fieldAccessOf(actor.fieldAccess, f.id),
      options: [...(f.options ?? []).map((x) => ({ id: x.id, label: x.label, archived: x.archived })), ...extra.map((label) => ({ id: `new:${label}`, label }))],
    };
  });
  const ctx: MapContext = {
    fields,
    stages: stagesFull.map(({ id, name, kind }) => ({ id, name, kind })),
    people: people.map((p) => ({ id: p.id, name: p.name, email: p.email, active: p.status === "active" })),
    tags,
    lostReasons: reasons,
    currency: settings!.currency,
    country: settings!.defaultCountryIso ?? null,
    today: todayIn(settings!.timezone),
    timezone: settings!.timezone,
    importerId: actor.userId,
    canAssign: can(actor, "leads.assign"),
    canManageFields: can(actor, "fields.manage"),
    canManageTags: can(actor, "settings.manage"),
    headerCount: o.headerCount,
    dateOrders: o.columnSettings?.dateOrders ?? {},
    decimalMarks: o.columnSettings?.decimalMarks ?? {},
  };
  return { ...ctx, stagesFull };
}

/** Existing leads sharing a contact with the draft (spec §6.9 steps 1, 3, 5). Run inside a lead_scope 'all' transaction. */
export async function findMatches(req: FastifyRequest, draft: LeadDraft, matchOn: Rules["matchOn"]) {
  const probes: { kind: "phone" | "email" | "instagram"; hash: string }[] = [];
  for (const kind of matchOn) {
    if (kind === "phone" && draft.phone.status === "valid" && draft.phone.e164) probes.push({ kind, hash: contactKeyHash("phone", draft.phone.e164) });
    if (kind === "email" && draft.email) probes.push({ kind, hash: contactKeyHash("email", draft.email.toLowerCase()) });
    if (kind === "instagram" && draft.instagram) probes.push({ kind, hash: contactKeyHash("instagram", draft.instagram.toLowerCase()) });
  }
  if (!probes.length) return [];
  const rows = await req.db
    .select({ leadId: schema.leadContactKeys.leadId, kind: schema.leadContactKeys.kind, active: schema.leads.lastActivityAt })
    .from(schema.leadContactKeys)
    .innerJoin(schema.leads, and(eq(schema.leads.id, schema.leadContactKeys.leadId), isNull(schema.leads.deletedAt)))
    .where(inArray(sql`(${schema.leadContactKeys.kind}, ${schema.leadContactKeys.keyHash})`, probes.map((p) => sql`(${p.kind}, ${p.hash})`)))
    .orderBy(desc(schema.leads.lastActivityAt));
  const rank = (k: string) => matchOn.indexOf(k as never);
  const seen = new Set<string>();
  return rows
    .sort((a, b) => rank(a.kind) - rank(b.kind) || (b.active?.getTime() ?? 0) - (a.active?.getTime() ?? 0))
    .filter((r) => (seen.has(r.leadId) ? false : (seen.add(r.leadId), true)))
    .map((r) => ({ leadId: r.leadId, kind: r.kind as "phone" | "email" | "instagram" }));
}

export const contactHashes = (draft: LeadDraft, matchOn: Rules["matchOn"]) =>
  matchOn.flatMap((k) =>
    k === "phone" && draft.phone.status === "valid" && draft.phone.e164 ? [contactKeyHash("phone", draft.phone.e164)]
    : k === "email" && draft.email ? [contactKeyHash("email", draft.email)]
    : k === "instagram" && draft.instagram ? [contactKeyHash("instagram", draft.instagram)]
    : [],
  );
```

(When `createMissingTags` is on, preview turns `TAG_UNKNOWN` into a "LUME will create the tag" warning instead of an error; at Start the tags really exist, so the run needs nothing special. If `inArray` over a row-constructor doesn't type-check in the installed Drizzle, write that one `where` with `sql` and `sql.join` over `(kind, hash)` pairs.)

- [ ] **Step 5: Implement `service.ts`** (drafts)

```ts
import { createHash } from "node:crypto";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  DEFAULT_RULES, INTAKE_LIMITS, MAPPABLE_TARGETS, analyzeColumns, can, mapRow, newId, readCsv, resolveColumnSettings,
  suggestMapping, validateMapping, type Issue, type Mapping, type Rules,
} from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { HttpError, badRequest, notFound } from "../../http/errors";
import { contactHashes, findMatches, loadMapContext } from "./context";
import { readImportFile, sealFile } from "./files";
import { withJobRequest } from "./job-request";

const I = schema.imports;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const signature = (headers: string[]) => sha(JSON.stringify(headers.map((h) => h.trim().toLowerCase())));
const safeName = (n: string) => n.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 200) || "import.csv";

async function mine(req: FastifyRequest, id: string) {
  const [imp] = await req.db.select().from(I).where(eq(I.id, id));
  if (!imp) throw notFound("IMPORT_NOT_FOUND", "Import not found");
  if (imp.status === "draft" && imp.createdBy !== req.actor!.userId) throw notFound("IMPORT_NOT_FOUND", "Import not found");
  return imp;
}

async function defaultRules(req: FastifyRequest, country: string | null): Promise<Rules> {
  const [pipeline] = await req.db.select().from(schema.pipelines).where(eq(schema.pipelines.isDefault, true));
  const [stage] = await req.db
    .select()
    .from(schema.stages)
    .where(and(eq(schema.stages.pipelineId, pipeline!.id), eq(schema.stages.kind, "open")))
    .orderBy(schema.stages.position)
    .limit(1);
  return DEFAULT_RULES({ pipelineId: pipeline!.id, stageId: stage!.id, country });
}

/** The full screen state for a draft: the file as read, the mapping, the rules, analysis and problems. */
async function draftView(req: FastifyRequest, d: AppDeps, imp: typeof I.$inferSelect) {
  const file = readImportFile(d.keyring, imp);
  const mapping = imp.mapping as Mapping;
  const rules = imp.rules as Rules;
  const ctx = await loadMapContext(req, { pipelineId: rules.pipelineId, headerCount: file.headers.length, pending: mapping });
  const analysis = analyzeColumns(file.rows, mapping, ctx);
  const settings = resolveColumnSettings(analysis, mapping, ctx);
  const problems: Issue[] = [...validateMapping(mapping, rules, ctx), ...settings.blocking];
  const [prior] = await req.db
    .select({ at: I.finishedAt, by: schema.users.name })
    .from(I)
    .leftJoin(schema.users, eq(schema.users.id, I.startedBy))
    .where(and(eq(I.fileSha256, imp.fileSha256), eq(I.status, "done"), ne(I.id, imp.id)))
    .orderBy(desc(I.finishedAt))
    .limit(1);
  const pipelines = await req.db.select({ id: schema.pipelines.id, name: schema.pipelines.name, isDefault: schema.pipelines.isDefault }).from(schema.pipelines);
  return {
    id: imp.id, status: imp.status, fileName: imp.fileName, fileBytes: imp.fileBytes,
    encoding: file.encoding, delimiter: file.delimiter, headerRow: file.headerRow, headers: file.headers,
    sample: file.rows.slice(0, 5), rowCount: file.rows.length, fileWarnings: file.fileWarnings,
    mapping, rules, targets: MAPPABLE_TARGETS(ctx.fields), analysis, problems,
    alreadyImported: prior ? { at: prior.at!.toISOString(), by: prior.by } : null,
    choices: {
      pipelines,
      stages: ctx.stages,
      people: ctx.people.filter((p) => p.active).map(({ id, name, email }) => ({ id, name, email })),
      fields: ctx.fields.filter((f) => !f.archived),
    },
    can: { assign: ctx.canAssign, manageFields: ctx.canManageFields, manageTags: ctx.canManageTags },
  };
}

export async function uploadImport(req: FastifyRequest, d: AppDeps, bytes: Buffer, rawName: string) {
  const fileName = safeName(rawName);
  if (bytes.length > INTAKE_LIMITS.bytes) throw badRequest("FILE_TOO_BIG", "This file is over 10 MB. Split it into smaller files.");
  const file = readCsv(new Uint8Array(bytes), { fileName });
  if (!file.ok) throw badRequest(file.code, file.message);
  const [settings] = await req.db.select().from(schema.settings).where(eq(schema.settings.id, 1));
  const fieldsCtx = await loadMapContext(req, { pipelineId: (await defaultRules(req, null)).pipelineId, headerCount: file.headers.length });
  const [memory] = await req.db.select().from(schema.importMappingMemory).where(eq(schema.importMappingMemory.headerSignature, signature(file.headers)));
  const mapping = suggestMapping(file.headers, fieldsCtx.fields, (memory?.mapping as Mapping) ?? null);
  let rules = await defaultRules(req, settings!.defaultCountryIso ?? null);
  const remembered = memory?.rules as Rules | undefined;
  if (remembered) {
    const ctx = await loadMapContext(req, { pipelineId: remembered.pipelineId, headerCount: file.headers.length });
    if (ctx.stages.some((s) => s.id === remembered.stageId)) rules = { ...rules, ...remembered };
  }
  const sourceId = newId();
  const id = newId();
  await req.db.insert(schema.leadSources).values({ id: sourceId, type: "csv", name: fileName, createdBy: req.actor!.userId });
  const [imp] = await req.db
    .insert(I)
    .values({
      id, sourceId, kind: "csv", status: "draft", fileEnc: sealFile(d.keyring, id, bytes), fileSha256: sha(bytes), fileName,
      fileBytes: bytes.length, encoding: file.encoding, delimiter: file.delimiter, headerRow: file.headerRow, headers: file.headers,
      rowCount: file.rows.length, mapping, rules, createdBy: req.actor!.userId,
    })
    .returning();
  return draftView(req, d, imp!);
}

export async function patchImport(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  patch: { encoding?: string; delimiter?: string; headerRow?: number; mapping?: Mapping; rules?: Rules },
) {
  const imp = await mine(req, id);
  if (imp.status !== "draft") throw new HttpError(409, "NOT_DRAFT", "This import has already started.");
  const reading = patch.encoding !== undefined || patch.delimiter !== undefined || patch.headerRow !== undefined;
  let next = { ...imp, ...(patch.mapping ? { mapping: patch.mapping } : {}), ...(patch.rules ? { rules: patch.rules } : {}) };
  if (reading) {
    next = { ...next, encoding: patch.encoding ?? imp.encoding, delimiter: patch.delimiter ?? imp.delimiter, headerRow: patch.headerRow ?? imp.headerRow };
    const file = readImportFile(d.keyring, next);
    const headersChanged = patch.headerRow !== undefined || file.headers.length !== (imp.headers as string[]).length;
    if (headersChanged && !patch.mapping) {
      const ctx = await loadMapContext(req, { pipelineId: (next.rules as Rules).pipelineId, headerCount: file.headers.length });
      next.mapping = suggestMapping(file.headers, ctx.fields, null);
    }
    next = { ...next, headers: file.headers, rowCount: file.rows.length, headerRow: file.headerRow, encoding: file.encoding, delimiter: file.delimiter };
  }
  const [saved] = await req.db
    .update(I)
    .set({ encoding: next.encoding, delimiter: next.delimiter, headerRow: next.headerRow, headers: next.headers, rowCount: next.rowCount, mapping: next.mapping, rules: next.rules })
    .where(eq(I.id, id))
    .returning();
  return draftView(req, d, saved!);
}

type Outcome = "create" | "merge" | "skip" | "error" | "empty";

export async function getDraft(req: FastifyRequest, d: AppDeps, id: string) {
  const imp = await mine(req, id);
  if (imp.status !== "draft") throw new HttpError(409, "NOT_DRAFT", "This import has already started.");
  return draftView(req, d, imp);
}

/** `errorsOnly`: scan the whole file (mapping only, no duplicate check) and return up to 20 rows with problems. */
export async function previewImport(req: FastifyRequest, d: AppDeps, id: string, o: { rows?: number[]; errorsOnly?: boolean } = {}) {
  const rowNumbers = o.rows;
  const imp = await mine(req, id);
  const file = readImportFile(d.keyring, imp);
  const mapping = imp.mapping as Mapping;
  const rules = imp.rules as Rules;
  const base = await loadMapContext(req, { pipelineId: rules.pipelineId, headerCount: file.headers.length, pending: mapping });
  const settings = resolveColumnSettings(analyzeColumns(file.rows, mapping, base), mapping, base);
  if (settings.blocking.length) throw badRequest("PREVIEW_BLOCKED", settings.blocking[0]!.message, settings.blocking);
  const ctx = { ...base, dateOrders: settings.dateOrders, decimalMarks: settings.decimalMarks };
  if (o.errorsOnly) {
    const found = [];
    for (let i = 0; i < file.rows.length && found.length < INTAKE_LIMITS.previewRows; i++) {
      const out = mapRow(file.rows[i]!, mapping, rules, ctx);
      const problems = out.kind === "error" ? out.problems.filter((p) => !(mapping.createMissingTags && p.code === "TAG_UNKNOWN")) : [];
      if (problems.length)
        found.push({ rowNumber: file.rowNumbers[i]!, outcome: "error" as Outcome, name: null, mergeInto: null, alsoMatches: 0, problems, warnings: out.kind === "error" ? out.warnings : [] });
    }
    return { rows: found, summary: { create: 0, merge: 0, skip: 0, error: found.length, empty: 0 }, scanned: file.rows.length };
  }
  const picks = rowNumbers?.length
    ? file.rowNumbers.map((n, i) => ({ n, i })).filter((x) => rowNumbers.includes(x.n)).slice(0, INTAKE_LIMITS.previewRows)
    : file.rowNumbers.slice(0, INTAKE_LIMITS.previewRows).map((n, i) => ({ n, i }));

  const seenInFile = new Map<string, number>(); // contact hash → the preview row that "created" it
  const rows = [];
  for (const { n, i } of picks) {
    const o = mapRow(file.rows[i]!, mapping, rules, ctx);
    if (o.kind === "empty") {
      rows.push({ rowNumber: n, outcome: "empty" as Outcome, name: null, mergeInto: null, alsoMatches: 0, problems: [], warnings: [] });
      continue;
    }
    let problems = o.kind === "error" ? o.problems : [];
    const warnings = [...o.warnings];
    if (mapping.createMissingTags) {
      const tagMisses = problems.filter((p) => p.code === "TAG_UNKNOWN");
      problems = problems.filter((p) => p.code !== "TAG_UNKNOWN");
      warnings.push(...tagMisses.map((p) => ({ ...p, code: "TAG_WILL_BE_CREATED", message: p.message.replace("No tag called", "LUME will create the tag") })));
    }
    if (o.kind === "error" && problems.length) {
      rows.push({ rowNumber: n, outcome: "error" as Outcome, name: null, mergeInto: null, alsoMatches: 0, problems, warnings });
      continue;
    }
    if (o.kind !== "draft") continue;
    const hashes = contactHashes(o.draft, rules.matchOn);
    const earlier = hashes.map((h) => seenInFile.get(h)).find((x) => x !== undefined);
    const matches = earlier === undefined
      ? await withJobRequest({ app: req.server, pool: d.pool, actor: req.actor!, requestId: `${req.id}:preview`, allLeads: true }, (all) => findMatches(all, o.draft, rules.matchOn))
      : [];
    let outcome: Outcome = "create";
    let mergeInto: { visible: true; leadId: string; name: string; ownerName: string | null } | { visible: false } | { row: number } | null = null;
    if (earlier !== undefined) {
      outcome = rules.onMatch === "merge" ? "merge" : rules.onMatch === "skip" ? "skip" : "create";
      mergeInto = { row: earlier };
    } else if (matches.length) {
      outcome = rules.onMatch === "merge" ? "merge" : rules.onMatch === "skip" ? "skip" : "create";
      const [seen] = await req.db // the importer's own RLS decides what they may learn
        .select({ id: schema.leads.id, name: schema.leads.name, ownerName: schema.users.name })
        .from(schema.leads)
        .leftJoin(schema.users, eq(schema.users.id, schema.leads.ownerId))
        .where(eq(schema.leads.id, matches[0]!.leadId));
      mergeInto = seen ? { visible: true, leadId: seen.id, name: seen.name, ownerName: seen.ownerName } : { visible: false };
    }
    if (outcome === "create") for (const h of hashes) if (!seenInFile.has(h)) seenInFile.set(h, n);
    rows.push({ rowNumber: n, outcome, name: o.draft.name, mergeInto, alsoMatches: Math.max(0, matches.length - 1), problems: [], warnings });
  }
  const summary: Record<Outcome, number> = { create: 0, merge: 0, skip: 0, error: 0, empty: 0 };
  for (const r of rows) summary[r.outcome]++;
  return { rows, summary, scanned: picks.length };
}

export async function discardImport(req: FastifyRequest, _d: AppDeps, id: string) {
  const imp = await mine(req, id);
  if (imp.status !== "draft") throw new HttpError(409, "NOT_DRAFT", "Only a draft can be discarded.");
  await req.db.delete(schema.leadSources).where(eq(schema.leadSources.id, imp.sourceId)); // cascades to the import
}

function view(req: FastifyRequest, imp: typeof I.$inferSelect & { startedByName: string | null }) {
  const actor = req.actor!;
  const rawHolder = can(actor, "leads.import") && can(actor, "leads.view", "all") && can(actor, "leads.contact.full");
  return {
    id: imp.id, status: imp.status, fileName: imp.fileName, rowCount: imp.rowCount, cursorRow: imp.cursorRow,
    counts: {
      created: imp.created, merged: imp.merged, skipped: imp.skipped, empty: imp.empty, errors: imp.errors, warnings: imp.warnings,
      nameFromContact: imp.nameFromContact, missingStageFields: imp.missingStageFields, phoneNeedsCountry: imp.phoneNeedsCountry,
    },
    startedBy: imp.startedBy ? { id: imp.startedBy, name: imp.startedByName ?? "Someone" } : null,
    createdAt: imp.createdAt.toISOString(), startedAt: imp.startedAt?.toISOString() ?? null, finishedAt: imp.finishedAt?.toISOString() ?? null,
    seenAt: imp.seenAt?.toISOString() ?? null, stopReason: imp.stopReason, sourceId: imp.sourceId,
    canSeeRows: imp.startedBy === actor.userId || imp.createdBy === actor.userId || rawHolder,
    mine: imp.createdBy === actor.userId,
  };
}

const withStarter = { imp: I, startedByName: schema.users.name };

export async function getImport(req: FastifyRequest, id: string) {
  const [row] = await req.db.select(withStarter).from(I).leftJoin(schema.users, eq(schema.users.id, I.startedBy)).where(eq(I.id, id));
  if (!row || (row.imp.status === "draft" && row.imp.createdBy !== req.actor!.userId)) throw notFound("IMPORT_NOT_FOUND", "Import not found");
  return view(req, { ...row.imp, startedByName: row.startedByName });
}

export async function listImports(req: FastifyRequest, cursor?: string) {
  const rows = await req.db
    .select(withStarter)
    .from(I)
    .leftJoin(schema.users, eq(schema.users.id, I.startedBy))
    .where(cursor ? lt(I.createdAt, new Date(cursor)) : undefined)
    .orderBy(desc(I.createdAt))
    .limit(51);
  const visible = rows.filter((r) => r.imp.status !== "draft" || r.imp.createdBy === req.actor!.userId);
  const page = visible.slice(0, 50);
  return { imports: page.map((r) => view(req, { ...r.imp, startedByName: r.startedByName })), nextCursor: rows.length > 50 ? page.at(-1)!.imp.createdAt.toISOString() : null };
}

export { signature, draftView, mine };
```

- [ ] **Step 6: Implement `routes.ts`**

```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { INTAKE_LIMITS } from "@lume/core";
import type { AppDeps } from "../../app";
import { discardImport, getDraft, getImport, listImports, patchImport, previewImport, uploadImport } from "./service";

const cfg = { permission: "leads.import" as const };
const params = z.object({ id: z.uuid() });
// Mapping and rules are validated in depth by validateMapping (with reasons); here only their outline.
const mapping = z.object({ columns: z.array(z.object({ column: z.number().int().min(0).max(199), to: z.enum(["ignore", "field", "name_part", "new_field"]) }).passthrough()).max(200), createMissingTags: z.boolean(), addOptions: z.record(z.string(), z.array(z.string().trim().min(1).max(60)).max(100)).optional() });
const rules = z.object({
  matchOn: z.array(z.enum(["phone", "email", "instagram"])).max(3),
  onMatch: z.enum(["merge", "skip", "duplicate"]),
  reopenClosedTo: z.uuid().nullable(),
  pipelineId: z.uuid(),
  stageId: z.uuid(),
  owner: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("unassigned") }),
    z.object({ mode: z.literal("user"), userId: z.uuid() }),
    z.object({ mode: z.literal("round_robin"), userIds: z.array(z.uuid()).max(200) }),
  ]),
  defaultCountry: z.string().length(2).nullable(),
  noName: z.enum(["use_contact", "error"]),
  unknownOwner: z.enum(["fallback", "error"]),
  requiredDefaults: z.record(z.string(), z.unknown()),
});

export async function importRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: INTAKE_LIMITS.bytes + 1 }, (_req, body, done) => done(null, body));
  r.post(
    "/api/v1/imports",
    { config: { ...cfg, idempotent: false }, bodyLimit: INTAKE_LIMITS.bytes + 1 },
    async (req, reply) => {
      const name = String(req.headers["x-file-name"] ?? "import.csv");
      return reply.code(201).send(await uploadImport(req, d, req.body as Buffer, decodeURIComponent(name)));
    },
  );
  r.patch(
    "/api/v1/imports/:id",
    {
      config: cfg,
      schema: {
        params,
        body: z
          .object({
            encoding: z.enum(["utf-8", "utf-16le", "utf-16be", "windows-1252"]).optional(),
            delimiter: z.enum([",", ";", "\t", "|"]).optional(),
            headerRow: z.number().int().min(1).max(INTAKE_LIMITS.headerSearch).optional(),
            mapping: mapping.optional(),
            rules: rules.optional(),
          })
          .strict(),
      },
    },
    (req) => patchImport(req, d, req.params.id, req.body as never),
  );
  r.post(
    "/api/v1/imports/:id/preview",
    { config: cfg, schema: { params, body: z.object({ rows: z.array(z.number().int().min(1)).max(INTAKE_LIMITS.previewRows).optional(), errorsOnly: z.boolean().optional() }) } },
    (req) => previewImport(req, d, req.params.id, req.body),
  );
  r.get("/api/v1/imports/:id/draft", { config: cfg, schema: { params } }, (req) => getDraft(req, d, req.params.id));
  r.delete("/api/v1/imports/:id", { config: cfg, schema: { params } }, async (req, reply) => {
    await discardImport(req, d, req.params.id);
    return reply.code(204).send();
  });
  r.get("/api/v1/imports", { config: cfg, schema: { querystring: z.object({ cursor: z.iso.datetime().optional() }) } }, (req) => listImports(req, req.query.cursor));
  r.get("/api/v1/imports/:id", { config: cfg, schema: { params } }, (req) => getImport(req, req.params.id));
}
```

Register in `app.ts` next to the other module routes: `await scope.register((s) => importRoutes(s, deps));` (the same form the settings routes use).

- [ ] **Step 7: Run the tests, the permission matrix and the API suite**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api'`
Expected: PASS, including the permission matrix with the new probes.

- [ ] **Step 8: Gate, commit, push**

```bash
bash "$G/gate.sh" > "$G/gate.log" 2>&1; tail -1 "$G/gate.log"
git add apps/api && git commit -m "feat(api): import drafts — upload a CSV, adjust how it's read, map it, preview exactly what will happen" && git push origin main
```

---

### Task 7: The run — start, the job, cancel and resume, and the report

**Files:**
- Create: `apps/api/src/modules/imports/runner.ts`, `apps/api/src/modules/imports/queue.ts`, `apps/api/src/modules/imports/start.ts`, `apps/api/src/modules/imports/report.ts`, `apps/api/src/modules/imports/run.test.ts`, `apps/api/src/modules/imports/acceptance.test.ts`
- Modify: `apps/api/src/modules/imports/routes.ts`, `apps/api/src/app.ts` (`AppDeps.imports?: { enqueue(id: string): Promise<void> }`), `apps/api/src/main.ts` (start the queue), `apps/api/test/harness.ts` (inline queue: `h.runImports()`), `apps/api/test/probes.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6; `insertLead`, `mergeFill`, `mergeIntoLead` (Task 5); `createField`, `updateField` from the fields module; `createTag` from the catalog module; `audit`.
- Produces:
  ```ts
  export async function startImport(req, d, id: string): Promise<ImportView>;   // 409 NOT_DRAFT; 400 MAPPING_INVALID with details
  export async function cancelImport(req, d, id: string): Promise<ImportView>;
  export async function resumeImport(req, d, id: string): Promise<ImportView>;
  export async function runImport(o: { app: FastifyInstance; pool: pg.Pool; keyring: Keyring }, importId: string): Promise<void>;
  export async function startImportQueue(o: { connectionString: string; app: FastifyInstance; pool: pg.Pool; keyring: Keyring }): Promise<{ enqueue(id: string): Promise<void>; stop(): Promise<void> }>;
  export async function listRows(req, d, id: string, q: { result?: string; cursor?: number }): Promise<{ rows: RowView[]; nextCursor: number | null }>;
  export async function errorsCsv(req, d, id: string): Promise<{ fileName: string; body: string }>;
  ```
- Routes: `POST /api/v1/imports/:id/start`, `POST /api/v1/imports/:id/cancel`, `POST /api/v1/imports/:id/resume`, `POST /api/v1/imports/:id/seen`, `GET /api/v1/imports/:id/rows`, `GET /api/v1/imports/:id/errors.csv` — all `leads.import`.

Rules decided here, from the spec:
- **At Start:**
  - the mapping and rules are re-validated against today's fields and stages (Review Focus 3);
  - the whole file is analysed, so a date column that can't be read refuses Start;
  - then, in this order: new fields, new options and missing tags are created, the mapping is rewritten to point at them, the header signature's memory is saved, and the import becomes `queued`.

  All of that is one request transaction, so a refusal leaves nothing half-made.
- **Every row is its own transaction** (`withJobRequest`, `allLeads: true`):
  1. claim the row with `INSERT … 'pending' ON CONFLICT DO NOTHING RETURNING`;
  2. map it;
  3. lock its contact hashes (`pg_advisory_xact_lock`, sorted);
  4. match, then create, merge or skip;
  5. write the row's result, the import's counters, `cursor_row` and (when a lead is created by turn-taking) `rr_cursor`.

  A crash anywhere rolls the whole row back, and nothing is counted twice.
- **Merges take an owner only from the row's owner column.** The owner rule, including turn-taking, applies only to leads it creates.
- **Before each batch of 200:** a `cancelling` status becomes `cancelled`, and if the starter lost `leads.import` (or `leads.assign` when the rules need it) the import becomes `stopped_access`.
- **Failures:** each run increments `attempts`. pg-boss retries a thrown run; the 5th failed attempt marks the import `failed` with the message, and Resume resets `attempts`.
- **Custom values** are validated with the field registry's create schema before insert, as a safety net behind `mapRow`. A failure is a row error, not a crash.

- [ ] **Step 1: Write the failing tests** (`apps/api/src/modules/imports/run.test.ts`)

```ts
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
const upload = async (c: AuthedClient, text: string, name = "leads.csv") =>
  (await c.inject({ method: "POST", url: "/api/v1/imports", payload: Buffer.from(text), headers: { "content-type": "application/octet-stream", "x-file-name": name } })).json();
const start = (c: AuthedClient, id: string) => c.inject({ method: "POST", url: `/api/v1/imports/${id}/start` });
const leadsNamed = async (name: string) => (await h.pool.query("SELECT * FROM leads WHERE name = $1 AND deleted_at IS NULL", [name])).rows;
const imp = async (id: string) => (await h.pool.query("SELECT * FROM imports WHERE id = $1", [id])).rows[0];

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("a run", () => {
  it("creates leads with their source, date, stage and an imported activity, and counts everything", async () => {
    const d = await upload(admin, "Name,Phone,Date,Stage\nAisha Khan,050 123 4567,04/03/2026,Contacted\n,,,\nBad,0501,01/01/2099,New\n");
    expect((await start(admin, d.id)).statusCode).toBe(200);
    await h.runImports();
    const done = await imp(d.id);
    expect(done).toMatchObject({ status: "done", created: 1, errors: 1, empty: 1 });
    const [lead] = await leadsNamed("Aisha Khan");
    expect(lead).toMatchObject({ phone_e164: "+971501234567", lead_created_at: "2026-03-04", source_id: done.source_id });
    const act = (await h.pool.query("SELECT type, payload FROM activities WHERE lead_id = $1", [lead.id])).rows;
    expect(act.map((a: { type: string }) => a.type)).toContain("imported");
  });

  it("Review Focus 2: the same number written two ways merges into one lead", async () => {
    const d = await upload(admin, "Name,Phone,Email\nZoe Park,+971 50 222 3333,\nZoe P,050 222 3333,zoe@x.com\n");
    await start(admin, d.id);
    await h.runImports();
    expect(await leadsNamed("Zoe Park")).toHaveLength(1);
    expect(await leadsNamed("Zoe P")).toHaveLength(0);
    expect((await leadsNamed("Zoe Park"))[0].email).toBe("zoe@x.com"); // filled by the merge
    expect(await imp(d.id)).toMatchObject({ created: 1, merged: 1 });
  });

  it("re-importing the same file creates nothing new, and never overwrites", async () => {
    const text = "Name,Phone,Value\nRe Import,0504445555,100\n";
    const a = await upload(admin, text);
    await start(admin, a.id);
    await h.runImports();
    await h.pool.query("UPDATE leads SET value = 999 WHERE name = 'Re Import'");
    const b = await upload(admin, text);
    expect(b.alreadyImported).not.toBeNull();
    await start(admin, b.id);
    await h.runImports();
    expect(await leadsNamed("Re Import")).toHaveLength(1);
    expect(Number((await leadsNamed("Re Import"))[0].value)).toBe(999);
    expect(await imp(b.id)).toMatchObject({ created: 0, merged: 1 });
  });

  it("Review Focus 4: start twice runs once", async () => {
    const d = await upload(admin, "Name\nOnly Once\n");
    const [a, b] = await Promise.all([start(admin, d.id), start(admin, d.id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    await h.runImports();
    expect(await leadsNamed("Only Once")).toHaveLength(1);
  });

  it("Review Focus 3: start re-validates against today's fields", async () => {
    const f = (await admin.inject({ method: "POST", url: "/api/v1/fields", payload: { key: "tier", label: "Tier", type: "text" } })).json().field;
    const d = await upload(admin, "Name,Tier\nA,Gold\n");
    expect(d.mapping.columns[1].field).toBe("tier");
    await admin.inject({ method: "POST", url: `/api/v1/fields/${f.id}/archive` });
    const r = await start(admin, d.id);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("MAPPING_INVALID");
    expect((await imp(d.id)).status).toBe("draft");
  });

  it("resumes after a crash without writing any row twice", async () => {
    const lines = Array.from({ length: 450 }, (_, i) => `Crash ${i},05${String(10000000 + i)}`).join("\n");
    const d = await upload(admin, `Name,Phone\n${lines}\n`);
    await start(admin, d.id);
    await h.runImports({ crashAfterRows: 230 }); // throws out of the runner after 230 committed rows
    expect((await imp(d.id)).created).toBe(230);
    await h.runImports(); // pg-boss's retry
    const done = await imp(d.id);
    expect(done).toMatchObject({ status: "done", created: 450 });
    expect(Number((await h.pool.query("SELECT count(*) FROM import_rows WHERE import_id = $1", [d.id])).rows[0].count)).toBe(450);
  });

  it("cancels before the next batch, and resumes the rest", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `Cancel ${i}`).join("\n");
    const d = await upload(admin, `Name\n${lines}\n`);
    await start(admin, d.id);
    await h.runImports({ beforeBatch: async (n) => { if (n === 1) await admin.inject({ method: "POST", url: `/api/v1/imports/${d.id}/cancel` }); } });
    expect(await imp(d.id)).toMatchObject({ status: "cancelled", created: 200 });
    expect((await admin.inject({ method: "POST", url: `/api/v1/imports/${d.id}/resume` })).statusCode).toBe(200);
    await h.runImports();
    expect(await imp(d.id)).toMatchObject({ status: "done", created: 300 });
  });

  it("stops when the importer loses Import leads", async () => {
    const person = await h.seedUser({ grants: [...ALL_GRANTS] });
    const c = await h.signIn(person);
    const d = await upload(c, `Name\n${Array.from({ length: 250 }, (_, i) => `Access ${i}`).join("\n")}\n`);
    await start(c, d.id);
    await h.runImports({ beforeBatch: async (n) => { if (n === 1) await h.revokeGrant(person.id, "leads.import"); } });
    expect(await imp(d.id)).toMatchObject({ status: "stopped_access", created: 200 });
  });

  it("two imports racing on the same contact make one lead", async () => {
    const a = await upload(admin, "Name,Email\nRace One,race@x.com\n");
    const b = await upload(admin, "Name,Email\nRace Two,race@x.com\n");
    await start(admin, a.id);
    await start(admin, b.id);
    await h.runImports({ parallel: true });
    const n = Number((await h.pool.query("SELECT count(*) FROM leads WHERE email = 'race@x.com'")).rows[0].count);
    expect(n).toBe(1);
  });

  it("gives created leads the owner rule by turns, skipping a disabled person, and never re-owns a merge", async () => {
    const p1 = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Turn One" });
    const p2 = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Turn Two", status: "disabled" });
    const p3 = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Turn Three" });
    const d = await upload(admin, "Name,Email\nRR A,rra@x.com\nRR B,rrb@x.com\nRR C,rrc@x.com\n");
    await admin.inject({ method: "PATCH", url: `/api/v1/imports/${d.id}`, payload: { rules: { ...d.rules, owner: { mode: "round_robin", userIds: [p1.id, p3.id] } } } });
    await h.pool.query("UPDATE users SET status = 'active' WHERE id = $1", [p2.id]);
    await start(admin, d.id);
    await h.runImports();
    const owners = (await h.pool.query("SELECT name, owner_id FROM leads WHERE name LIKE 'RR %' ORDER BY name")).rows.map((r: { owner_id: string }) => r.owner_id);
    expect(owners).toEqual([p1.id, p3.id, p1.id]);
  });

  it("the report lists failed rows as CSV, safe to open in Excel", async () => {
    const d = await upload(admin, "Name,Stage,Note\nGood,New,=1+2\nBad,Nowhere,=HYPERLINK(\"x\")\n");
    await start(admin, d.id);
    await h.runImports();
    const r = await admin.inject({ method: "GET", url: `/api/v1/imports/${d.id}/errors.csv` });
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.body.startsWith("﻿Problem,Name,Stage,Note")).toBe(true);
    expect(r.body).toContain("'=HYPERLINK");
    expect(r.body).not.toContain("Good");
  });
});
```

`apps/api/src/modules/imports/acceptance.test.ts` — the report's own Phase 2 acceptance (spec §11):

```ts
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

/** 500 rows: 400 distinct people, 100 repeats in other formats; phones local, international, 00-prefixed, spaced, scientific, blank. */
function messyFile(): { text: string; expect: { distinct: number; statuses: Record<string, number> } } {
  const rows: string[] = [];
  const status: Record<string, number> = { valid: 0, invalid: 0, missing: 0 };
  for (let i = 0; i < 400; i++) {
    const national = `5${String(10000000 + i * 7).slice(-8)}`; // 9 digits after the 0: a UAE mobile shape
    const forms = [`0${national}`, `+971 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`, `00971${national}`, `+971${national}`];
    const phone = i % 50 === 0 ? "" : i % 97 === 0 ? "9.71501E+11" : forms[i % forms.length]!;
    rows.push(`Person ${i},${phone},p${i}@example.test`);
  }
  for (let i = 0; i < 100; i++) rows.push(`Person ${i} again,,P${i}@EXAMPLE.test`); // repeats by email, other case
  for (let i = 0; i < 400; i++) (i % 50 === 0 ? status.missing++ : i % 97 === 0 ? status.invalid++ : status.valid++);
  return { text: `Name,Phone,Email\n${rows.join("\n")}\n`, expect: { distinct: 400, statuses: status } };
}

it("a 500-row messy sheet imports with zero duplicates and correct phone statuses; re-import and a shuffled copy create nothing", async () => {
  const { text, expect: want } = messyFile();
  const run = async (body: string) => {
    const d = (await admin.inject({ method: "POST", url: "/api/v1/imports", payload: Buffer.from(body), headers: { "content-type": "application/octet-stream", "x-file-name": "messy.csv" } })).json();
    await admin.inject({ method: "POST", url: `/api/v1/imports/${d.id}/start` });
    await h.runImports();
    return (await h.pool.query("SELECT created, merged, errors FROM imports WHERE id = $1", [d.id])).rows[0];
  };
  expect(await run(text)).toMatchObject({ created: 400, merged: 100, errors: 0 });
  const counts = (await h.pool.query("SELECT phone_status, count(*)::int n FROM leads WHERE name LIKE 'Person %' GROUP BY 1")).rows;
  expect(Object.fromEntries(counts.map((r: { phone_status: string; n: number }) => [r.phone_status, r.n]))).toEqual(want.statuses);
  expect(await run(text)).toMatchObject({ created: 0, merged: 500 });
  const [head, ...body] = text.trim().split("\n");
  const shuffled = [head, ...body.map((l, i) => ({ l, k: (i * 7919) % body.length })).sort((a, b) => a.k - b.k).map((x) => x.l)].join("\n");
  expect(await run(`${shuffled}\n`)).toMatchObject({ created: 0 });
  expect(Number((await h.pool.query("SELECT count(*) FROM leads WHERE name LIKE 'Person %'")).rows[0].count)).toBe(want.distinct);
});
```

Harness additions (`apps/api/test/harness.ts`) — an inline queue and two test helpers:

```ts
// in createHarness, after the app is built:
const queued: string[] = [];
deps.imports = { enqueue: async (id) => void queued.push(id) };
// …and on the returned Harness:
async runImports(o: { crashAfterRows?: number; beforeBatch?: (n: number) => Promise<void>; parallel?: boolean } = {}) {
  const ids = queued.splice(0);
  const once = (id: string) => runImport({ app, pool, keyring, testHooks: o }, id).catch((e) => { if (!String(e).includes("test crash")) throw e; queued.push(id); });
  if (o.parallel) await Promise.all(ids.map(once));
  else for (const id of ids) await once(id);
},
async revokeGrant(userId: string, key: string) {
  await ownerPool.query("DELETE FROM role_permissions rp USING user_roles ur WHERE ur.role_id = rp.role_id AND ur.user_id = $1 AND rp.permission_key = $2", [userId, key]);
  await ownerPool.query("SELECT pg_notify('lume_rbac', $1)", [userId]);
  app.actorCache.invalidate(userId);
},
```

(`buildApp` reads `deps.imports` lazily, through `deps`, so setting it after the build works. `runImport` takes an optional `testHooks` whose `crashAfterRows` throws `new Error("test crash")` after that many committed rows and whose `beforeBatch(n)` is awaited before batch `n`; the production queue never passes it.)

- [ ] **Step 2: Run to see them fail**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/modules/imports'`
Expected: FAIL — 404 on `/start`, and `h.runImports` is not a function.

- [ ] **Step 3: Implement `start.ts`** (start, cancel, resume, seen)

```ts
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { analyzeColumns, can, fold, resolveColumnSettings, validateMapping, type ColumnMap, type Mapping, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest } from "../../http/errors";
import { createTag } from "../catalog/service";
import { createField, updateField } from "../fields/service";
import { loadMapContext } from "./context";
import { readImportFile } from "./files";
import { getImport, mine, signature } from "./service";

const I = schema.imports;
const fieldKey = (label: string, taken: Set<string>) => {
  let base = fold(label).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
  if (!/^[a-z]/.test(base)) base = `f_${base}`;
  base = base.slice(0, 36).replace(/_+$/, "");
  let k = base;
  for (let n = 2; taken.has(k); n++) k = `${base}_${n}`;
  return k;
};

export async function startImport(req: FastifyRequest, d: AppDeps, id: string) {
  const [locked] = await req.db.execute<{ status: string }>(sql`SELECT status FROM imports WHERE id = ${id} FOR UPDATE`).then((r) => r.rows);
  const imp = await mine(req, id);
  if (!locked || locked.status !== "draft") throw new HttpError(409, "NOT_DRAFT", "This import has already started.");
  const file = readImportFile(d.keyring, imp);
  let mapping = imp.mapping as Mapping;
  const rules = imp.rules as Rules;
  const ctx = await loadMapContext(req, { pipelineId: rules.pipelineId, headerCount: file.headers.length, pending: mapping });
  const settings = resolveColumnSettings(analyzeColumns(file.rows, mapping, ctx), mapping, ctx);
  const problems = [...validateMapping(mapping, rules, ctx), ...settings.blocking];
  if (problems.length) throw badRequest("MAPPING_INVALID", problems[0]!.message, problems);

  // Create what the importer chose to add, then point the mapping at it.
  const taken = new Set(ctx.fields.map((f) => f.key));
  const columns: ColumnMap[] = [];
  for (const c of mapping.columns) {
    if (c.to !== "new_field") {
      columns.push(c);
      continue;
    }
    const key = fieldKey(c.label, taken);
    taken.add(key);
    await createField(req, { key, label: c.label, type: c.type });
    columns.push({ column: c.column, to: "field", field: key, transform: c.transform });
  }
  for (const [key, labels] of Object.entries(mapping.addOptions ?? {})) {
    const f = ctx.fields.find((x) => x.key === key)!;
    const live = f.options.filter((o) => !o.archived && !o.id.startsWith("new:"));
    const fresh = labels.filter((l) => !live.some((o) => fold(o.label) === fold(l)));
    if (fresh.length) await updateField(req, f.id, { options: [...live.map((o) => ({ id: o.id, label: o.label })), ...fresh.map((label) => ({ label }))] });
  }
  if (mapping.createMissingTags) {
    const tagCol = columns.find((c) => c.to === "field" && c.field === "tags");
    if (tagCol) {
      const labels = new Set<string>();
      for (const row of file.rows)
        for (const part of (row[tagCol.column] ?? "").split(/\s*[,;]\s*/).filter(Boolean))
          if (!ctx.tags.some((t) => fold(t.label) === fold(part)) && ![...labels].some((l) => fold(l) === fold(part))) labels.add(part.trim());
      for (const label of labels) await createTag(req, { label });
    }
  }
  mapping = { columns, createMissingTags: false };

  await req.db
    .insert(schema.importMappingMemory)
    .values({ headerSignature: signature(file.headers), mapping, rules, updatedBy: req.actor!.userId })
    .onConflictDoUpdate({ target: schema.importMappingMemory.headerSignature, set: { mapping, rules, updatedBy: req.actor!.userId, updatedAt: new Date() } });
  await req.db
    .update(I)
    .set({ status: "queued", mapping, rules, columnSettings: { dateOrders: settings.dateOrders, decimalMarks: settings.decimalMarks }, startedBy: req.actor!.userId, startedAt: new Date(), attempts: 0 })
    .where(eq(I.id, id));
  await audit(req, { action: "import.started", entityType: "import", entityId: id, diff: { file: imp.fileName, rows: file.rows.length } });
  req.afterCommit(() => void d.imports?.enqueue(id));
  return getImport(req, id);
}

export async function cancelImport(req: FastifyRequest, _d: AppDeps, id: string) {
  const imp = await mine(req, id);
  if (imp.status === "queued") await req.db.update(I).set({ status: "cancelled", stopReason: "cancelled", finishedAt: new Date() }).where(eq(I.id, id));
  else if (imp.status === "running") await req.db.update(I).set({ status: "cancelling" }).where(eq(I.id, id));
  else throw new HttpError(409, "NOT_RUNNING", "This import isn't running.");
  await audit(req, { action: "import.cancelled", entityType: "import", entityId: id });
  return getImport(req, id);
}

export async function resumeImport(req: FastifyRequest, d: AppDeps, id: string) {
  const imp = await mine(req, id);
  if (!["cancelled", "stopped_access", "failed"].includes(imp.status)) throw new HttpError(409, "NOT_RESUMABLE", "This import can't be resumed.");
  const actor = req.actor!;
  const rules = imp.rules as Rules;
  if (!can(actor, "leads.import") || (rules.owner.mode !== "unassigned" && !(rules.owner.mode === "user" && rules.owner.userId === actor.userId) && !can(actor, "leads.assign")))
    throw new HttpError(403, "FORBIDDEN", "You don't have access to this");
  await req.db.update(I).set({ status: "queued", attempts: 0, stopReason: null, finishedAt: null, startedBy: actor.userId }).where(eq(I.id, id));
  req.afterCommit(() => void d.imports?.enqueue(id));
  return getImport(req, id);
}

export async function markSeen(req: FastifyRequest, id: string) {
  await mine(req, id);
  await req.db.update(I).set({ seenAt: new Date() }).where(eq(I.id, id));
}
```

- [ ] **Step 4: Implement `runner.ts`**

```ts
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { INTAKE_LIMITS, can, mapRow, startOfDayUtc, type Issue, type Keyring, type LeadDraft, type Mapping, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { loadFieldRegistry } from "../../leads/fields";
import type { ActorRecord } from "../../rbac/actor";
import { insertLead, mergeFill, mergeIntoLead } from "../leads/writer";
import { contactHashes, findMatches, loadMapContext } from "./context";
import { readImportFile } from "./files";
import { withJobRequest } from "./job-request";

const I = schema.imports;
const R = schema.importRows;
const MAX_ATTEMPTS = 5;
type Hooks = { crashAfterRows?: number; beforeBatch?: (n: number) => Promise<void> };
type Deps = { app: FastifyInstance; pool: pg.Pool; keyring: Keyring; testHooks?: Hooks };
type ImportRow = typeof I.$inferSelect;
type Ctx = Awaited<ReturnType<typeof loadMapContext>>;
type Db = ReturnType<typeof drizzle<typeof schema>>;

const fingerprint = (d: LeadDraft, cells: string[]) => {
  const identity = [d.leadCreatedAt ?? "", d.phone.e164 ?? "", d.email ?? "", d.instagram ?? ""];
  const basis = identity.some(Boolean) ? identity : cells.map((c) => c.trim());
  return createHash("sha256").update(basis.join("\u001f")).digest("hex");
};
/** A transaction-scoped lock on one contact (the first 64 bits of its hash). */
const lock = (hex: string) => sql`SELECT pg_advisory_xact_lock(('x' || ${hex.slice(0, 16)})::bit(64)::bigint)`;

/** Does this run give leads to people other than the starter? Then it needs leads.assign too. */
const assigns = (imp: ImportRow, actor: ActorRecord) => {
  const rules = imp.rules as Rules;
  const mapping = imp.mapping as Mapping;
  return (
    rules.owner.mode === "round_robin" ||
    (rules.owner.mode === "user" && rules.owner.userId !== actor.userId) ||
    mapping.columns.some((c) => c.to === "field" && c.field === "owner")
  );
};

/** Spec §7.2: runs an import to the end, or until it's cancelled, loses access, or fails. Safe to call again at any time. */
export async function runImport(o: Deps, importId: string): Promise<void> {
  const db = drizzle(o.pool, { schema }); // the intake tables have no RLS (amendment 5)
  const [claimed] = await db
    .update(I)
    .set({ status: sql`CASE WHEN ${I.status} = 'cancelling' THEN ${I.status} ELSE 'running' END`, attempts: sql`${I.attempts} + 1` })
    .where(sql`${I.id} = ${importId} AND ${I.status} IN ('queued', 'running', 'cancelling')`)
    .returning();
  if (!claimed) return; // cancelled, done, or never started: nothing to do
  try {
    await runRows(o, db, claimed);
  } catch (e) {
    if (String(e).includes("test crash")) throw e;
    const message = String((e as Error)?.message ?? e).slice(0, 300);
    if (claimed.attempts >= MAX_ATTEMPTS) {
      await db.update(I).set({ status: "failed", stopReason: `failed: ${message}`, finishedAt: new Date() }).where(eq(I.id, importId));
      await auditAs(o, claimed.startedBy!, "import.failed", importId, { message });
      return;
    }
    throw e; // pg-boss retries, with backoff
  }
}

async function auditAs(o: Deps, userId: string, action: string, importId: string, diff: Record<string, unknown>) {
  const actor = await o.app.actorCache.get(userId);
  if (!actor) {
    await o.pool.query(
      "INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, diff) VALUES ($1, $2, 'import', $3, $4)",
      [userId, action, importId, diff],
    );
    return;
  }
  await withJobRequest({ app: o.app, pool: o.pool, actor, requestId: `import:${importId}:${action}`, allLeads: false }, (req) =>
    audit(req, { action, entityType: "import", entityId: importId, diff }),
  );
}

async function runRows(o: Deps, db: Db, imp: ImportRow) {
  const file = readImportFile(o.keyring, imp);
  const rules = imp.rules as Rules;
  const mapping = imp.mapping as Mapping;
  const columnSettings = imp.columnSettings as { dateOrders: Record<number, "DMY" | "MDY" | "YMD">; decimalMarks: Record<number, "." | ","> };
  const startedBy = imp.startedBy!;
  let actor = await o.app.actorCache.get(startedBy);
  if (!actor) throw new Error("the person who started this import no longer exists");
  const ctx = await withJobRequest({ app: o.app, pool: o.pool, actor, requestId: `import:${imp.id}:context`, allLeads: true }, (req) =>
    loadMapContext(req, { pipelineId: rules.pipelineId, headerCount: file.headers.length, columnSettings }),
  );
  const turns =
    rules.owner.mode === "round_robin"
      ? ctx.people
          .filter((p) => (rules.owner as { userIds: string[] }).userIds.includes(p.id))
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      : [];

  const from = file.rowNumbers.findIndex((n) => n > imp.cursorRow);
  let committed = 0;
  if (from !== -1)
    for (let batchStart = from, batch = 0; batchStart < file.rows.length; batchStart += INTAKE_LIMITS.batch, batch++) {
      await o.testHooks?.beforeBatch?.(batch);
      const [now] = await db.select({ status: I.status }).from(I).where(eq(I.id, imp.id));
      if (now!.status === "cancelling") {
        await db.update(I).set({ status: "cancelled", stopReason: "cancelled", finishedAt: new Date() }).where(eq(I.id, imp.id));
        return;
      }
      o.app.actorCache.invalidate(startedBy); // permissions are re-read from the database before every batch
      actor = await o.app.actorCache.get(startedBy);
      if (!actor || !can(actor, "leads.import") || (assigns(imp, actor) && !can(actor, "leads.assign"))) {
        await db.update(I).set({ status: "stopped_access", stopReason: "access_changed", finishedAt: new Date() }).where(eq(I.id, imp.id));
        await auditAs(o, startedBy, "import.stopped", imp.id, { reason: "access_changed" });
        return;
      }
      const end = Math.min(batchStart + INTAKE_LIMITS.batch, file.rows.length);
      for (let i = batchStart; i < end; i++) {
        await withJobRequest(
          { app: o.app, pool: o.pool, actor, requestId: `import:${imp.id}:${file.rowNumbers[i]}`, allLeads: true },
          (req) => oneRow(req, o.keyring, { imp, rules, mapping }, ctx, turns, file.rows[i]!, file.rowNumbers[i]!),
        );
        committed++;
        if (o.testHooks?.crashAfterRows !== undefined && committed >= o.testHooks.crashAfterRows) throw new Error("test crash");
      }
    }
  const [done] = await db
    .update(I)
    .set({ status: "done", finishedAt: new Date() })
    .where(sql`${I.id} = ${imp.id} AND ${I.status} IN ('running', 'cancelling')`)
    .returning({ created: I.created, merged: I.merged, skipped: I.skipped, empty: I.empty, errors: I.errors });
  if (done) await auditAs(o, startedBy, "import.finished", imp.id, done);
}

type Run = { imp: ImportRow; rules: Rules; mapping: Mapping };
type Counter = "created" | "merged" | "skipped" | "empty" | "errors" | "warnings" | "name_from_contact" | "missing_stage_fields" | "phone_needs_country";

/** Spec §6.9–§6.10 for one row, in the caller's transaction (every lead visible, acting as the importer). */
async function oneRow(req: FastifyRequest, keyring: Keyring, run: Run, ctx: Ctx, turns: Ctx["people"], cells: string[], rowNumber: number) {
  const { imp, rules, mapping } = run;
  const claimed = await req.db
    .insert(R)
    .values({ importId: imp.id, rowIndex: rowNumber, result: "pending", rawEnc: keyring.encrypt(JSON.stringify(cells), `import-row:${imp.id}:${rowNumber}`) })
    .onConflictDoNothing()
    .returning({ id: R.id });
  if (!claimed.length) return; // an earlier attempt already finished this row

  const save = async (
    result: "created" | "merged" | "skipped" | "error",
    f: { leadId?: string | null; problems?: Issue[]; warnings?: Issue[]; alsoMatched?: string[]; fingerprint?: string | null },
    counters: Partial<Record<Counter, number>>,
  ) => {
    await req.db
      .update(R)
      .set({ result, leadId: f.leadId ?? null, problems: f.problems ?? [], warnings: f.warnings ?? [], alsoMatched: f.alsoMatched ?? [], fingerprint: f.fingerprint ?? null })
      .where(eq(R.id, claimed[0]!.id));
    const sets = Object.entries(counters)
      .filter(([, n]) => n)
      .map(([k, n]) => sql`${sql.identifier(k)} = ${sql.identifier(k)} + ${n}`);
    await req.db.execute(sql`UPDATE imports SET ${sql.join([...sets, sql`cursor_row = GREATEST(cursor_row, ${rowNumber})`], sql`, `)} WHERE id = ${imp.id}`);
  };

  const outcome = mapRow(cells, mapping, rules, ctx);
  if (outcome.kind === "empty") return save("skipped", { problems: [{ column: null, code: "EMPTY_ROW", message: "Empty row" }] }, { empty: 1 });
  if (outcome.kind === "error")
    return save("error", { problems: outcome.problems, warnings: outcome.warnings }, { errors: 1, warnings: outcome.warnings.length ? 1 : 0 });

  const draft = outcome.draft;
  const warnings = [...outcome.warnings];
  const fp = fingerprint(draft, cells);
  // A safety net behind mapRow: the field registry's own create schema, exactly as a hand-made lead meets it.
  const custom = (await loadFieldRegistry(req)).custom.create.safeParse(draft.custom);
  if (!custom.success)
    return save(
      "error",
      {
        problems: custom.error.issues.map((i) => ({ column: null, code: "INVALID_FIELD", message: `${i.path.join(".")}: ${i.message}` })),
        warnings,
      },
      { errors: 1, warnings: warnings.length ? 1 : 0 },
    );

  for (const h of contactHashes(draft, rules.matchOn).sort()) await req.db.execute(lock(h));
  const matches = await findMatches(req, draft, rules.matchOn);
  const contact = {
    phoneRaw: draft.phone.raw,
    phoneE164: draft.phone.e164,
    phoneCountryIso: draft.phone.countryIso,
    phoneStatus: draft.phone.status,
    email: draft.email,
    instagramHandle: draft.instagram,
  };
  const also = matches.slice(1).map((m) => m.leadId);

  if (matches.length && rules.onMatch !== "duplicate") {
    const target = matches[0]!.leadId;
    if (rules.onMatch === "skip")
      return save(
        "skipped",
        {
          leadId: target,
          warnings,
          alsoMatched: also,
          fingerprint: fp,
          problems: [{ column: null, code: "MATCHED_SKIPPED", message: "Matches an existing lead; skipped." }],
        },
        { skipped: 1, warnings: warnings.length ? 1 : 0 },
      );
    const [lead] = await req.db.select().from(schema.leads).where(eq(schema.leads.id, target));
    const tagIds = (await req.db.select({ id: schema.leadTags.tagId }).from(schema.leadTags).where(eq(schema.leadTags.leadId, target))).map((t) => t.id);
    // A merge takes an owner only from the row's owner column; the owner rule is for leads it creates.
    const { fill, filled } = mergeFill(
      lead!,
      { contact, value: draft.value, leadCreatedAt: draft.leadCreatedAt, ownerId: draft.ownerId ?? null, custom: custom.data, tagIds: draft.tagIds },
      tagIds,
      rules.reopenClosedTo,
    );
    await mergeIntoLead(req, lead!, fill, {
      type: "imported_again",
      payload: { importId: imp.id, file: imp.fileName, row: rowNumber, filled, extraPhones: draft.extraPhones, warnings: warnings.map((w) => w.code) },
    });
    return save("merged", { leadId: target, warnings, alsoMatched: also, fingerprint: fp }, { merged: 1, warnings: warnings.length ? 1 : 0 });
  }

  // Create: the owner from the row, else the owner rule.
  let ownerId: string | null = draft.ownerId ?? null;
  if (draft.ownerId === undefined) {
    if (rules.owner.mode === "user") {
      const chosen = rules.owner.userId;
      ownerId = ctx.people.find((p) => p.id === chosen && p.active)?.id ?? null;
      if (!ownerId) warnings.push({ column: null, code: "OWNER_RULE_INACTIVE", message: "The chosen owner can't take leads now; left unassigned." });
    } else if (rules.owner.mode === "round_robin") {
      const active = turns.filter((p) => p.active);
      if (!active.length)
        warnings.push({ column: null, code: "OWNER_RULE_INACTIVE", message: "Nobody chosen to take turns can take leads now; left unassigned." });
      else {
        const { rows } = await req.db.execute<{ n: number }>(sql`UPDATE imports SET rr_cursor = rr_cursor + 1 WHERE id = ${imp.id} RETURNING rr_cursor - 1 AS n`);
        ownerId = active[rows[0]!.n % active.length]!.id;
      }
    }
  }
  const stageId = draft.stageId ?? rules.stageId;
  const stage = ctx.stagesFull.find((s) => s.id === stageId)!;
  const origin = draft.leadCreatedAt ? startOfDayUtc(draft.leadCreatedAt, ctx.timezone) : null;
  const leadId = await insertLead(req, {
    pipelineId: rules.pipelineId,
    stageId,
    ownerId,
    name: draft.name,
    contact,
    value: draft.value,
    productId: null,
    leadCreatedAt: draft.leadCreatedAt,
    custom: custom.data,
    tagIds: draft.tagIds,
    sourceId: imp.sourceId,
    lostReasonId: draft.lostReasonId,
    closedAt: stage.kind === "open" ? null : (origin ?? new Date()),
    stageKind: stage.kind,
    stageEnteredAt: origin ?? new Date(),
    activity: { type: "imported", payload: { importId: imp.id, file: imp.fileName, row: rowNumber, extraPhones: draft.extraPhones, warnings: warnings.map((w) => w.code) } },
    assignReason: "imported",
  });
  // A stage's required fields aren't enforced on import (spec §6.5), but they're counted.
  const core: Record<string, unknown> = {
    phone: draft.phone.raw, email: draft.email, instagram: draft.instagram, value: draft.value, lead_created_at: draft.leadCreatedAt, owner: ownerId,
  };
  const have = new Set<string>();
  for (const f of ctx.fields) {
    const v = f.isCore ? core[f.key] : custom.data[f.key];
    if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) have.add(f.id);
  }
  const missing = stage.requiredFieldIds.some((id) => !have.has(id));
  if (missing) warnings.push({ column: null, code: "MISSING_STAGE_FIELDS", message: `${stage.name} asks for fields this lead doesn't have yet.` });
  return save("created", { leadId, warnings, alsoMatched: also, fingerprint: fp }, {
    created: 1,
    warnings: warnings.length ? 1 : 0,
    name_from_contact: draft.nameFromContact ? 1 : 0,
    phone_needs_country: draft.phone.status === "needs_country" ? 1 : 0,
    missing_stage_fields: missing ? 1 : 0,
  });
}
```

- [ ] **Step 5: Implement `report.ts`** (rows and the failed-rows CSV)

```ts
import { and, asc, eq, gt } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import Papa from "papaparse";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { HttpError } from "../../http/errors";
import { getImport } from "./service";

const R = schema.importRows;
const safeCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

async function allowed(req: FastifyRequest, id: string) {
  const v = await getImport(req, id);
  if (!v.canSeeRows) throw new HttpError(403, "ROWS_HIDDEN", "Only the person who ran this import (or someone who can see every lead's contact details) can see its rows.");
  return v;
}

export async function listRows(req: FastifyRequest, d: AppDeps, id: string, q: { result?: string; cursor?: number }) {
  await allowed(req, id);
  const rows = await req.db
    .select()
    .from(R)
    .where(and(eq(R.importId, id), q.result ? eq(R.result, q.result as never) : undefined, q.cursor ? gt(R.rowIndex, q.cursor) : undefined))
    .orderBy(asc(R.rowIndex))
    .limit(101);
  const page = rows.slice(0, 100);
  const leadIds = page.map((r) => r.leadId).filter((x): x is string => !!x);
  const visible = leadIds.length
    ? new Map((await req.db.select({ id: schema.leads.id, name: schema.leads.name }).from(schema.leads)).filter((l) => leadIds.includes(l.id)).map((l) => [l.id, l.name]))
    : new Map<string, string>();
  return {
    rows: page.map((r) => ({
      rowNumber: r.rowIndex, result: r.result, problems: r.problems, warnings: r.warnings,
      lead: r.leadId ? (visible.has(r.leadId) ? { visible: true, id: r.leadId, name: visible.get(r.leadId)! } : { visible: false }) : null,
      cells: r.rawEnc ? (JSON.parse(d.keyring.decrypt(r.rawEnc, `import-row:${id}:${r.rowIndex}`)) as string[]) : null,
    })),
    nextCursor: rows.length > 100 ? page.at(-1)!.rowIndex : null,
  };
}

export async function errorsCsv(req: FastifyRequest, d: AppDeps, id: string) {
  const v = await allowed(req, id);
  const [imp] = await req.db.select({ headers: schema.imports.headers }).from(schema.imports).where(eq(schema.imports.id, id));
  const rows = await req.db.select().from(R).where(and(eq(R.importId, id), eq(R.result, "error"))).orderBy(asc(R.rowIndex));
  const data = rows.map((r) => {
    const cells = r.rawEnc ? (JSON.parse(d.keyring.decrypt(r.rawEnc, `import-row:${id}:${r.rowIndex}`)) as string[]) : [];
    return [r.problems.map((p) => p.message).join(" "), ...cells].map((c) => safeCell(c ?? ""));
  });
  const body = `﻿${Papa.unparse([["Problem", ...(imp!.headers as string[])], ...data], { newline: "\r\n" })}\r\n`;
  return { fileName: `${v.fileName.replace(/\.[^.]+$/, "")}-problems.csv`, body };
}
```

(Papa Parse comes from `@lume/core`'s dependency; add it to `apps/api` with `scripts/dev.sh add papaparse@^5.5.3 --filter @lume/api` and `-D @types/papaparse` so the API imports it directly.)

- [ ] **Step 6: Routes and the queue**

Add to `routes.ts`:

```ts
r.post("/api/v1/imports/:id/start", { config: cfg, schema: { params } }, (req) => startImport(req, d, req.params.id));
r.post("/api/v1/imports/:id/cancel", { config: cfg, schema: { params } }, (req) => cancelImport(req, d, req.params.id));
r.post("/api/v1/imports/:id/resume", { config: cfg, schema: { params } }, (req) => resumeImport(req, d, req.params.id));
r.post("/api/v1/imports/:id/seen", { config: cfg, schema: { params } }, async (req, reply) => {
  await markSeen(req, req.params.id);
  return reply.code(204).send();
});
r.get(
  "/api/v1/imports/:id/rows",
  { config: cfg, schema: { params, querystring: z.object({ result: z.enum(["created", "merged", "skipped", "error"]).optional(), cursor: z.coerce.number().int().optional() }) } },
  (req) => listRows(req, d, req.params.id, req.query),
);
r.get("/api/v1/imports/:id/errors.csv", { config: cfg, schema: { params } }, async (req, reply) => {
  const { fileName, body } = await errorsCsv(req, d, req.params.id);
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    .send(body);
});
```

`queue.ts`:

```ts
import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type pg from "pg";
import type { Keyring } from "@lume/core";
import { runImport } from "./runner";

/** pg-boss inside the API, as lume_app (spec amendment 1). One run per import at a time (singletonKey). */
export async function startImportQueue(o: { connectionString: string; app: FastifyInstance; pool: pg.Pool; keyring: Keyring }) {
  const boss = new PgBoss({ connectionString: o.connectionString, schema: "pgboss", migrate: false });
  boss.on("error", (err) => o.app.log.error({ err }, "import queue error"));
  await boss.start();
  await boss.work<{ id: string }>("imports.run", { batchSize: 1 }, async ([job]) => runImport({ app: o.app, pool: o.pool, keyring: o.keyring }, job!.data.id));
  const enqueue = async (id: string) => void (await boss.send("imports.run", { id }, { singletonKey: id, expireInSeconds: 3600 }));
  // After a restart, anything that was queued or mid-run carries on.
  const { rows } = await o.pool.query("SELECT id FROM imports WHERE status IN ('queued', 'running', 'cancelling')");
  for (const r of rows) await enqueue(r.id);
  return { enqueue, stop: () => boss.stop({ graceful: true }) };
}
```

`app.ts`: `AppDeps` gains `imports?: { enqueue(id: string): Promise<void> }`. `main.ts`, after `buildApp`:

```ts
const queue = await startImportQueue({ connectionString: cfg.DATABASE_URL_APP, app, pool, keyring });
deps.imports = { enqueue: queue.enqueue };  // `deps` is the object passed to buildApp, now held in a const
```

and stop it (`await queue.stop()`) before `app.close()` on SIGTERM/SIGINT. Add the six routes to `probes.ts`.

- [ ] **Step 7: Run the tests**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api'`
Expected: PASS — `run.test.ts`, `acceptance.test.ts` (the 500-row test), the permission matrix, and everything before.

- [ ] **Step 8: Gate, commit, push**

```bash
bash "$G/gate.sh" > "$G/gate.log" 2>&1; tail -1 "$G/gate.log"
git add apps/api pnpm-lock.yaml && git commit -m "feat(api): run an import — every row once, merged not duplicated, resumable, cancellable, with a report" && git push origin main
```

---

### Task 8: The bulk phone fix

**Files:**
- Modify: `apps/api/src/modules/leads/bulk.ts`, `apps/api/src/modules/leads/routes.ts` (the bulk body schema), `apps/api/src/modules/leads/bulk.test.ts`, `apps/web/src/lib/leads/types.ts` (`BulkAction`), `apps/web/src/lib/leads/bulk.ts` (verb and reasons), `apps/web/src/components/leads/BulkBar.tsx`, `apps/web/src/components/leads/BulkBar.test.tsx`

**Interfaces:**
- Produces: bulk action `{ type: "set_phone_country"; country: string }` (ISO 3166 alpha-2). Skip codes: `ALREADY_VALID`, `NO_NUMBER`, `STILL_INVALID`, plus the existing permission codes.

- [ ] **Step 1: Write the failing tests**

API (`bulk.test.ts`, new `describe`):

```ts
describe("set_phone_country", () => {
  it("gives unreadable numbers a country, and leaves the rest alone with reasons", async () => {
    const a = await h.seedLead({ ownerId: null, phoneRaw: "0501234567", phoneStatus: "needs_country" });
    const b = await h.seedLead({ ownerId: null, phone: "+971509998888" });
    const c = await h.seedLead({ ownerId: null });
    const d = await h.seedLead({ ownerId: null, phoneRaw: "123", phoneStatus: "invalid" });
    const r = (await admin.inject({ method: "POST", url: "/api/v1/leads/bulk", payload: { ids: [a, b, c, d], action: { type: "set_phone_country", country: "AE" } } })).json();
    expect(r.updated).toEqual([a]);
    expect(r.skipped).toEqual([
      { id: b, code: "ALREADY_VALID" },
      { id: c, code: "NO_NUMBER" },
      { id: d, code: "STILL_INVALID" },
    ]);
    const lead = (await h.pool.query("SELECT phone_e164, phone_status, phone_country_iso FROM leads WHERE id = $1", [a])).rows[0];
    expect(lead).toEqual({ phone_e164: "+971501234567", phone_status: "valid", phone_country_iso: "AE" });
    const act = (await h.pool.query("SELECT type, payload FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1", [a])).rows[0];
    expect(act).toMatchObject({ type: "phone_country_set", payload: { country: "AE" } });
  });

  it("works on a masked rep's own leads without revealing a digit, and never on others'", async () => {
    const repUser = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }, { key: "leads.edit", scope: "own" }, { key: "leads.bulk_edit", scope: "own" }] });
    const rep = await h.signIn(repUser);
    const mine = await h.seedLead({ ownerId: repUser.id, phoneRaw: "0501112222", phoneStatus: "needs_country" });
    const theirs = await h.seedLead({ ownerId: null, phoneRaw: "0503334444", phoneStatus: "needs_country" });
    const res = await rep.inject({ method: "POST", url: "/api/v1/leads/bulk", payload: { ids: [mine, theirs], action: { type: "set_phone_country", country: "AE" } } });
    const r = res.json();
    expect(r.updated).toEqual([mine]);
    expect(r.skipped[0].id).toBe(theirs);
    expect(res.body).not.toMatch(/0501112222|501112222/);
  });

  it("refuses an unknown country", async () => {
    const r = await admin.inject({ method: "POST", url: "/api/v1/leads/bulk", payload: { ids: [], action: { type: "set_phone_country", country: "ZZ" } } });
    expect(r.statusCode).toBe(400);
  });
});
```

Web (`BulkBar.test.tsx`, new case):

```tsx
it("offers Set country when a selected lead's number needs one, and reports the result", async () => {
  vi.mocked(leadsClient.bulk).mockResolvedValue({ ok: true, status: 200, data: { updated: ["l1"], skipped: [{ id: "l2", code: "STILL_INVALID" }] } });
  renderBar({ selected: [testLead({ id: "l1", phone: { display: "05• ••• ••67", masked: true, status: "needs_country" } }), testLead({ id: "l2" })] });
  await userEvent.click(screen.getByRole("button", { name: "Set country…" }));
  await userEvent.click(screen.getByRole("button", { name: /^Country/ }));
  await userEvent.type(screen.getByRole("combobox", { name: "Search countries" }), "united arab{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "Set country" }));
  expect(leadsClient.bulk).toHaveBeenCalledWith(["l1", "l2"], { type: "set_phone_country", country: "AE" });
  expect(await screen.findByText("1 fixed, 1 skipped: still not a number LUME can read")).toBeInTheDocument();
});
```

(`renderBar` is the helper already in `BulkBar.test.tsx`; if it's named differently there, use that.)

- [ ] **Step 2: Run to see them fail**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/modules/leads/bulk.test.ts apps/web/src/components/leads/BulkBar.test.tsx'`
Expected: FAIL — 400 on the unknown action type; no "Set country…" button.

- [ ] **Step 3: Implement**

`bulk.ts` — the action type and its case:

```ts
export type BulkAction =
  | { type: "stage"; stageId: string; lostReasonId?: string; lostNote?: string }
  | { type: "assign"; ownerId: string | null }
  | { type: "tags"; add?: string[]; remove?: string[] }
  | { type: "delete" }
  | { type: "set_phone_country"; country: string };
```

```ts
        case "set_phone_country": {
          if (!canOnRecord(req.actor!, "leads.edit", lead.ownerId)) throw forbidden();
          if (lead.phoneStatus === "valid") throw badRequest("ALREADY_VALID", "Already a number LUME can read");
          if (!lead.phoneRaw) throw badRequest("NO_NUMBER", "No number");
          const p = normalizePhone(lead.phoneRaw, action.country);
          if (p.status !== "valid") throw badRequest("STILL_INVALID", "Still not a number LUME can read");
          await req.db
            .update(schema.leads)
            .set({ phoneE164: p.e164, phoneCountryIso: p.countryIso, phoneStatus: "valid", version: sql`${schema.leads.version} + 1`, updatedAt: new Date() })
            .where(eq(schema.leads.id, id));
          await recordActivity(req, id, "phone_country_set", { country: action.country }); // no digits in the history payload
          break;
        }
```

(import `normalizePhone` from `@lume/core`.) In `routes.ts`, the bulk body's discriminated union gains `z.object({ type: z.literal("set_phone_country"), country: z.string().regex(/^[A-Z]{2}$/).refine(isCountry, "Unknown country") })`, where `isCountry` is `(c) => getCountries().includes(c as never)` from `libphonenumber-js`.

Web — `lib/leads/bulk.ts`: `VERB.set_phone_country = "fixed"`, `WHY.ALREADY_VALID = "already readable"`, `WHY.NO_NUMBER = "have no number"`, `WHY.STILL_INVALID = "still not a number LUME can read"`. `types.ts`: add the action to `BulkAction`. `BulkBar.tsx`: when any selected lead's `phone.status` is `needs_country` or `invalid`, show a `Popover` "Set country…" holding the existing `CountryPicker` (label "Country", default the business country from the catalog) and a primary "Set country" button that runs `leadsClient.bulk(ids, { type: "set_phone_country", country })`, then shows `bulkSummary` in the existing result line.

- [ ] **Step 4: Run to see them pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/api/src/modules/leads apps/web/src/components/leads apps/web/src/lib/leads'`
Expected: PASS.

- [ ] **Step 5: Gate, commit, push**

```bash
bash "$G/gate.sh" > "$G/gate.log" 2>&1; tail -1 "$G/gate.log"
git add apps && git commit -m "feat: give many unreadable phone numbers their country at once" && git push origin main
```

---

### Task 9: Retention, and the audit log's words for imports

**Files:**
- Modify: `apps/worker/src/maintenance.ts`, `apps/worker/src/boss.ts`, `apps/worker/src/maintenance.integration.test.ts`, `apps/web/src/lib/settings/audit.ts`, `apps/web/src/lib/settings/audit.test.ts`

**Interfaces:**
- Produces: `MaintenanceJobs.purgeImportFiles(): Promise<{ files: number; rows: number; drafts: number }>`; cron `imports.retention` daily at 03:23 UTC. Audit phrases for `import.started`, `import.finished`, `import.cancelled`, `import.stopped`, `import.failed`, `import.discarded` (area "Leads").

- [ ] **Step 1: Write the failing tests**

`maintenance.integration.test.ts` (new case, same style as the idempotency purge beside it):

```ts
it("clears import files and raw rows 30 days after they finish, and deletes drafts never started after 7", async () => {
  const src = "00000000-0000-7000-8000-0000000000a1";
  await owner.query(`INSERT INTO lead_sources (id, type, name) VALUES ($1, 'csv', 'x'), ('00000000-0000-7000-8000-0000000000a2', 'csv', 'y'), ('00000000-0000-7000-8000-0000000000a3', 'csv', 'z')`, [src]);
  await owner.query(`INSERT INTO imports (id, source_id, kind, status, file_enc, file_sha256, file_name, file_bytes, finished_at, created_at) VALUES
    ('00000000-0000-7000-8000-0000000000b1', $1, 'csv', 'done', 'x', 's', 'old.csv', 1, now() - interval '31 days', now() - interval '31 days'),
    ('00000000-0000-7000-8000-0000000000b2', '00000000-0000-7000-8000-0000000000a2', 'csv', 'done', 'x', 's', 'new.csv', 1, now() - interval '2 days', now() - interval '2 days'),
    ('00000000-0000-7000-8000-0000000000b3', '00000000-0000-7000-8000-0000000000a3', 'csv', 'draft', 'x', 's', 'draft.csv', 1, NULL, now() - interval '8 days')`, [src]);
  await owner.query(`INSERT INTO import_rows (import_id, row_index, result, raw_enc) VALUES ('00000000-0000-7000-8000-0000000000b1', 2, 'created', 'x')`);
  const r = await jobs.purgeImportFiles();
  expect(r).toEqual({ files: 1, rows: 1, drafts: 1 });
  const left = (await owner.query("SELECT id, file_enc IS NULL AS purged FROM imports ORDER BY id")).rows;
  expect(left).toEqual([
    { id: "00000000-0000-7000-8000-0000000000b1", purged: true },
    { id: "00000000-0000-7000-8000-0000000000b2", purged: false },
  ]);
});
```

`audit.test.ts`: add the six actions to `WRITTEN`, and:

```ts
it("says what an import did", () => {
  expect(auditPhrase(entry("import.finished", { diff: { created: 812, merged: 40, errors: 3 } }), people)).toBe(
    "Riya Sharma imported leads: 812 created, 40 merged, 3 with problems",
  );
});
```

- [ ] **Step 2: Run to see them fail**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/worker apps/web/src/lib/settings/audit.test.ts'`
Expected: FAIL — `jobs.purgeImportFiles is not a function`; missing phrases.

- [ ] **Step 3: Implement**

`maintenance.ts`:

```ts
/** Spec §4.6: files and raw rows go 30 days after an import finishes; drafts never started go after 7 days. */
async purgeImportFiles() {
  const files = await pool.query(
    "UPDATE imports SET file_enc = NULL, purged_at = now() WHERE file_enc IS NOT NULL AND status NOT IN ('draft', 'queued', 'running', 'cancelling') AND finished_at < now() - interval '30 days' RETURNING id",
  );
  const ids = files.rows.map((r) => r.id);
  const rows = ids.length ? await pool.query("UPDATE import_rows SET raw_enc = NULL WHERE import_id = ANY($1) AND raw_enc IS NOT NULL", [ids]) : { rowCount: 0 };
  const drafts = await pool.query(
    "DELETE FROM lead_sources WHERE id IN (SELECT source_id FROM imports WHERE status = 'draft' AND created_at < now() - interval '7 days')",
  );
  return { files: files.rowCount ?? 0, rows: rows.rowCount ?? 0, drafts: drafts.rowCount ?? 0 };
},
```

In `boss.ts`, beside the other crons:

```ts
await boss.schedule("imports.retention", "23 3 * * *", {}, { tz: "UTC" });
await boss.work("imports.retention", { batchSize: 1 }, async () => {
  const r = await opts.maintenance.purgeImportFiles();
  opts.log.info(r, "import files purged");
});
```

`audit.ts`, in `AUDIT_ACTIONS`:

```ts
  "import.started": { area: "Leads", phrase: "started an import" },
  "import.finished": {
    area: "Leads",
    phrase: (d) => `imported leads: ${n(d.created)} created, ${n(d.merged)} merged, ${n(d.errors)} with problems`,
  },
  "import.cancelled": { area: "Leads", phrase: "cancelled an import" },
  "import.stopped": { area: "Leads", phrase: "had an import stopped when their access changed" },
  "import.failed": { area: "Leads", phrase: "had an import fail" },
  "import.discarded": { area: "Leads", phrase: "discarded an import draft" },
```

and have `discardImport` (Task 6) write `import.discarded` with the file name.

- [ ] **Step 4: Run to see them pass**, then **Step 5: gate, commit, push** — `feat: import files are cleared after 30 days, and the audit log says what each import did`.

---

### Task 10: Web client, the Import sheet and the File step

**Files:**
- Create: `apps/web/src/lib/imports/client.ts`, `apps/web/src/lib/imports/types.ts`, `apps/web/src/components/imports/ImportSheet.tsx`, `apps/web/src/components/imports/FileStep.tsx`, `apps/web/src/components/imports/imports.module.css`, `apps/web/src/components/imports/ImportSheet.test.tsx`
- Modify: `apps/web/src/lib/api.ts` (`api.upload`)

**Interfaces:**
- Consumes: the API of Tasks 6–7 (response shapes `DraftView`, `PreviewRow`, `ImportView` copied into `lib/imports/types.ts`); `INTAKE_LIMITS` from `@lume/core/shared`.
- Produces:
  ```ts
  export const importsClient: {
    upload(file: File): Promise<ApiResult<DraftView>>;
    draft(id: string): Promise<ApiResult<DraftView>>;
    patch(id: string, p: Partial<{ encoding: Encoding; delimiter: Delimiter; headerRow: number; mapping: Mapping; rules: Rules }>): Promise<ApiResult<DraftView>>;
    preview(id: string, o?: { rows?: number[]; errorsOnly?: boolean }): Promise<ApiResult<{ rows: PreviewRow[]; summary: Record<string, number>; scanned: number }>>;
    start(id: string): Promise<ApiResult<ImportView>>; cancel(id: string): Promise<ApiResult<ImportView>>; resume(id: string): Promise<ApiResult<ImportView>>;
    seen(id: string): Promise<ApiResult<null>>; discard(id: string): Promise<ApiResult<null>>;
    get(id: string): Promise<ApiResult<ImportView>>; list(cursor?: string): Promise<ApiResult<{ imports: ImportView[]; nextCursor: string | null }>>;
  };
  export function ImportSheet(props: { open: boolean; draftId?: string; onClose(): void }): JSX.Element | null;
  ```
- Steps are `"file" | "columns" | "rules" | "preview" | "run"`; the rail's buttons are named "1 File", "2 Columns", … and a step is reachable only once the steps before it have no blocking problems.

- [ ] **Step 1: Write the failing test** (`ImportSheet.test.tsx`)

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importsClient } from "@/lib/imports/client";
import { testDraft } from "@/lib/imports/test-draft";
import { ImportSheet } from "./ImportSheet";

vi.mock("@/lib/imports/client", () => ({
  importsClient: { upload: vi.fn(), draft: vi.fn(), patch: vi.fn(), preview: vi.fn(), start: vi.fn(), cancel: vi.fn(), resume: vi.fn(), seen: vi.fn(), discard: vi.fn(), get: vi.fn(), list: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const file = (text: string, name = "leads.csv") => new File([text], name, { type: "text/csv" });

beforeEach(() => vi.clearAllMocks());

describe("ImportSheet — File", () => {
  it("uploads a dropped file, shows how LUME read it, and moves on to Columns", async () => {
    vi.mocked(importsClient.upload).mockResolvedValue(ok(testDraft()));
    render(<ImportSheet open onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Import leads" });
    await userEvent.upload(within(dialog).getByLabelText(/Choose a CSV file/), file("Name\nA\n"));
    expect(importsClient.upload).toHaveBeenCalled();
    expect(await within(dialog).findByText("leads.csv · 3 rows")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Encoding: UTF-8/ })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByRole("heading", { name: "Match your columns" })).toBeInTheDocument();
  });

  it("says why a file can't be read, in LUME's words", async () => {
    vi.mocked(importsClient.upload).mockResolvedValue({ ok: false, status: 400, code: "NOT_CSV_EXCEL", message: "This is an Excel file. Save it as CSV (File → Save as → CSV UTF-8) and upload that." });
    render(<ImportSheet open onClose={vi.fn()} />);
    await userEvent.upload(screen.getByLabelText(/Choose a CSV file/), file("x", "leads.xlsx"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save it as CSV");
  });

  it("refuses a file over 10 MB before uploading it", async () => {
    render(<ImportSheet open onClose={vi.fn()} />);
    const big = new File([new Uint8Array(10_485_761)], "big.csv");
    await userEvent.upload(screen.getByLabelText(/Choose a CSV file/), big);
    expect(importsClient.upload).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("over 10 MB");
  });

  it("warns when the same file was imported before", async () => {
    vi.mocked(importsClient.upload).mockResolvedValue(ok(testDraft({ alreadyImported: { at: "2026-09-03T10:00:00Z", by: "Leila Haddad" } })));
    render(<ImportSheet open onClose={vi.fn()} />);
    await userEvent.upload(screen.getByLabelText(/Choose a CSV file/), file("Name\nA\n"));
    expect(await screen.findByText(/already imported on 3 Sep by Leila Haddad/)).toBeInTheDocument();
  });

  it("changes the header row and re-reads the file", async () => {
    vi.mocked(importsClient.upload).mockResolvedValue(ok(testDraft()));
    vi.mocked(importsClient.patch).mockResolvedValue(ok(testDraft({ headerRow: 2 })));
    render(<ImportSheet open onClose={vi.fn()} />);
    await userEvent.upload(screen.getByLabelText(/Choose a CSV file/), file("x\nName\nA\n"));
    await userEvent.click(await screen.findByRole("button", { name: /Header: row 1/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Row 2" }));
    expect(importsClient.patch).toHaveBeenCalledWith(testDraft().id, { headerRow: 2 });
  });

  it("asks before closing a draft, and keeps it for later", async () => {
    vi.mocked(importsClient.upload).mockResolvedValue(ok(testDraft()));
    const onClose = vi.fn();
    render(<ImportSheet open onClose={onClose} />);
    await userEvent.upload(screen.getByLabelText(/Choose a CSV file/), file("Name\nA\n"));
    await screen.findByText("leads.csv · 3 rows");
    await userEvent.keyboard("{Escape}");
    const ask = screen.getByRole("alertdialog", { name: "Keep this import for later?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Keep for later" }));
    expect(importsClient.discard).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
```

Also create `apps/web/src/lib/imports/test-draft.ts` (test-only fixture) returning a `DraftView` for `leads.csv`: 3 rows, headers `["Full name", "Mobile", "Email"]`, the suggested mapping name/phone/email, default rules (`matchOn` all three, merge, `pipelineId: "p1"`, `stageId: "s-new"`, unassigned, `defaultCountry: "AE"`, `noName: "use_contact"`, `unknownOwner: "fallback"`, `requiredDefaults: {}`), `analysis` with no unmatched values, `problems: []`, `alreadyImported: null`, choices from `testCatalog()` (fictional names only), and `can` all true — `testDraft(over)` spreads `over`.

- [ ] **Step 2: Run to see it fail**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/web/src/components/imports'`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the client and the upload helper**

`lib/api.ts` — a raw-body variant of `send` (same CSRF, 429 and error handling):

```ts
/** A file as the request body (import upload): no JSON, its own content type, its name in a header. */
async function sendFile<T>(path: string, file: File): Promise<ApiResult<T>> {
  const token = await csrfToken();
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-file-name": encodeURIComponent(file.name),
    "idempotency-key": crypto.randomUUID(),
  };
  if (token) headers["x-csrf-token"] = token;
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", credentials: "same-origin", headers, body: file });
  } catch {
    return { ok: false, status: 0, code: "OFFLINE", message: OFFLINE };
  }
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* an edge error page */
  }
  if (res.ok) return { ok: true, status: res.status, data: payload as T };
  const err = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  if (res.status === 413) return { ok: false, status: 413, code: "FILE_TOO_BIG", message: "This file is over 10 MB. Split it into smaller files." };
  return { ok: false, status: res.status, code: err?.code ?? "UNKNOWN", message: err?.message ?? "LUME couldn't upload this file. Try again." };
}
```

and `upload: <T>(path: string, file: File) => sendFile<T>(path, file)` on `api`.

`lib/imports/client.ts`:

```ts
"use client";
import { api } from "@/lib/api";
import type { DraftView, ImportView, PreviewResult } from "./types";

const base = "/api/v1/imports";
export const importsClient = {
  upload: (file: File) => api.upload<DraftView>(base, file),
  draft: (id: string) => api.get<DraftView>(`${base}/${id}/draft`),
  patch: (id: string, p: Record<string, unknown>) => api.patch<DraftView>(`${base}/${id}`, p),
  preview: (id: string, o: { rows?: number[]; errorsOnly?: boolean } = {}) => api.post<PreviewResult>(`${base}/${id}/preview`, o),
  start: (id: string) => api.post<ImportView>(`${base}/${id}/start`),
  cancel: (id: string) => api.post<ImportView>(`${base}/${id}/cancel`),
  resume: (id: string) => api.post<ImportView>(`${base}/${id}/resume`),
  seen: (id: string) => api.post<null>(`${base}/${id}/seen`),
  discard: (id: string) => api.del<null>(`${base}/${id}`),
  get: (id: string) => api.get<ImportView>(`${base}/${id}`),
  list: (cursor?: string) => api.get<{ imports: ImportView[]; nextCursor: string | null }>(`${base}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
};
```

`lib/imports/types.ts` copies the API's `DraftView`, `PreviewRow`, `PreviewResult`, `ImportView`, `Mapping`, `ColumnMap`, `Rules`, `Issue`, `ColumnAnalysis`, `IntakeField`, `Encoding`, `Delimiter` exactly as Tasks 3 and 6 define them (types only; the engine never runs in the browser).

- [ ] **Step 4: Implement `ImportSheet.tsx` and `FileStep.tsx`**

`ImportSheet.tsx` owns the draft and the step, and renders the rail and the current step:

```tsx
"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { importsClient } from "@/lib/imports/client";
import type { DraftView, ImportView } from "@/lib/imports/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import { ColumnsStep } from "./ColumnsStep";
import { FileStep } from "./FileStep";
import { PreviewStep } from "./PreviewStep";
import { ProgressStep } from "./ProgressStep";
import { RulesStep } from "./RulesStep";
import s from "./imports.module.css";

export type Step = "file" | "columns" | "rules" | "preview" | "run";
const STEPS: { id: Step; label: string }[] = [
  { id: "file", label: "File" },
  { id: "columns", label: "Columns" },
  { id: "rules", label: "Rules" },
  { id: "preview", label: "Preview" },
  { id: "run", label: "Import" },
];
/** Problems that belong to a step (the rest belong to Rules). */
const COLUMN_CODES = new Set(["FIELD_TWICE", "UNKNOWN_FIELD", "FIELD_NOT_EDITABLE", "SOURCE_NOT_MAPPABLE", "LAST_WITHOUT_FIRST", "NEW_FIELD_NOT_ALLOWED", "NEW_FIELD_LABEL_TAKEN", "NEW_OPTION_NOT_ALLOWED", "NEW_TAG_NOT_ALLOWED", "DATE_ORDER_NEEDED", "NO_NAME_COLUMN", "REQUIRED_FIELD_UNCOVERED"]);

export function ImportSheet({ open, draftId, onClose }: { open: boolean; draftId?: string; onClose(): void }) {
  const reduce = useReducedMotion();
  const titleId = useId();
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [run, setRun] = useState<ImportView | null>(null);
  const [step, setStep] = useState<Step>("file");
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!open || !draftId) return;
    void importsClient.draft(draftId).then((r) => {
      if (r.ok) {
        setDraft(r.data);
        setStep("columns");
      }
    });
  }, [open, draftId]);

  const columnsBlocked = !!draft?.problems.some((p) => COLUMN_CODES.has(p.code));
  const rulesBlocked = !!draft?.problems.some((p) => !COLUMN_CODES.has(p.code));
  const reachable = (id: Step) =>
    id === "file" ||
    (draft !== null && (id === "columns" || (id === "rules" && !columnsBlocked) || (id === "preview" && !columnsBlocked && !rulesBlocked))) ||
    (id === "run" && run !== null);

  const close = () => {
    if (draft && !run) setAsking(true); // a draft is kept unless discarded
    else onClose();
  };

  if (!open) return null;
  return (
    <AnimatePresence>
      <motion.div className={s.scrim} aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={s.sheet}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !(e.target as HTMLElement).closest("[data-search-panel]")) {
            e.stopPropagation();
            close();
          }
        }}
        initial={reduce ? { opacity: 0, y: 0 } : { opacity: 1, y: "4vh" }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0, y: 0 } : { opacity: 0, y: "4vh" }}
        transition={toMotion(SPRINGS.drawer)}
      >
        <header className={s.head}>
          <IconButton label="Close (Esc)" onClick={close}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </IconButton>
          <h2 id={titleId} className={s.title}>
            Import leads
          </h2>
          <nav aria-label="Import steps" className={s.rail}>
            <ol>
              {STEPS.map((x, i) => (
                <li key={x.id}>
                  <button type="button" className={s.railStep} aria-current={step === x.id ? "step" : undefined} disabled={!reachable(x.id) || (run !== null && x.id !== "run")} onClick={() => setStep(x.id)}>
                    <span className={s.railNum} aria-hidden>{i + 1}</span> {x.label}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </header>
        <div className={s.body}>
          {step === "file" && <FileStep draft={draft} onDraft={setDraft} onContinue={() => setStep("columns")} />}
          {step === "columns" && draft && <ColumnsStep draft={draft} onDraft={setDraft} onContinue={() => setStep("rules")} blocked={columnsBlocked} />}
          {step === "rules" && draft && <RulesStep draft={draft} onDraft={setDraft} onContinue={() => setStep("preview")} blocked={rulesBlocked} />}
          {step === "preview" && draft && (
            <PreviewStep
              draft={draft}
              onFix={(to) => setStep(to)}
              onStarted={(v) => {
                setRun(v);
                setStep("run");
              }}
            />
          )}
          {step === "run" && run && <ProgressStep initial={run} onClose={onClose} />}
        </div>
        {asking && draft && (
          <div role="alertdialog" aria-modal="true" aria-labelledby={`${titleId}-keep`} className={s.ask}>
            <h3 id={`${titleId}-keep`}>Keep this import for later?</h3>
            <p>LUME keeps it in Settings → Imports for 7 days, as you left it.</p>
            <div className={s.askActions}>
              <Button variant="ghost" onClick={async () => { await importsClient.discard(draft.id); onClose(); }}>
                Discard
              </Button>
              <Button variant="primary" autoFocus onClick={onClose}>
                Keep for later
              </Button>
            </div>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
```

`FileStep.tsx`:

```tsx
"use client";
import { useRef, useState } from "react";
import { INTAKE_LIMITS } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { importsClient } from "@/lib/imports/client";
import type { DraftView, Encoding, Delimiter } from "@/lib/imports/types";
import s from "./imports.module.css";

const ENCODINGS: [Encoding, string][] = [["utf-8", "UTF-8"], ["windows-1252", "Windows (Western)"], ["utf-16le", "UTF-16"]];
const DELIMITERS: [Delimiter, string][] = [[",", "Comma"], [";", "Semicolon"], ["\t", "Tab"], ["|", "Pipe"]];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };

export function FileStep({ draft, onDraft, onContinue }: { draft: DraftView | null; onDraft(d: DraftView): void; onContinue(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const take = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    if (file.size > INTAKE_LIMITS.bytes) return setProblem("This file is over 10 MB. Split it into smaller files.");
    setBusy(true);
    const r = await importsClient.upload(file);
    setBusy(false);
    if (r.ok) onDraft(r.data);
    else setProblem(r.message);
  };
  const reread = async (p: { encoding?: Encoding; delimiter?: Delimiter; headerRow?: number }) => {
    if (!draft) return;
    const r = await importsClient.patch(draft.id, p);
    if (r.ok) onDraft(r.data);
    else setProblem(r.message);
  };

  return (
    <section className={s.step} aria-labelledby="file-title">
      <h3 id="file-title" className={s.stepTitle}>Choose a file</h3>
      <p className={s.lede}>A CSV from a spreadsheet or another CRM, up to 10 MB and 20,000 rows. LUME checks every row before anything is imported.</p>
      <label
        className={s.drop}
        data-over={over || undefined}
        data-busy={busy || undefined}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files[0]); }}
      >
        <input ref={input} type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" className={s.srOnly} aria-label="Choose a CSV file" onChange={(e) => void take(e.target.files?.[0])} />
        <span className={s.dropTitle}>{busy ? "Reading…" : draft ? "Choose a different file" : "Drop a CSV here, or choose one"}</span>
        <span className={s.dropHint}>Excel files: File → Save as → CSV UTF-8 first.</span>
      </label>
      {problem && <p role="alert" className={s.problem}>{problem}</p>}
      {draft && (
        <div className={s.readout}>
          <p className={s.fileLine}>{draft.fileName} · {draft.rowCount.toLocaleString("en")} rows</p>
          <div className={s.chips}>
            <Popover label="Encoding" triggerClassName={s.chip} trigger={<>Encoding: {ENCODINGS.find(([e]) => e === draft.encoding)?.[1] ?? draft.encoding}</>} role="menu">
              {(close) => ENCODINGS.map(([e, l]) => (
                <button key={e} type="button" role="menuitemradio" aria-checked={draft.encoding === e} className={s.menuItem} onClick={() => { close(); void reread({ encoding: e }); }}>{l}</button>
              ))}
            </Popover>
            <Popover label="Separator" triggerClassName={s.chip} trigger={<>Separator: {DELIMITERS.find(([d]) => d === draft.delimiter)?.[1]}</>} role="menu">
              {(close) => DELIMITERS.map(([d, l]) => (
                <button key={l} type="button" role="menuitemradio" aria-checked={draft.delimiter === d} className={s.menuItem} onClick={() => { close(); void reread({ delimiter: d }); }}>{l}</button>
              ))}
            </Popover>
            <Popover label="Header row" triggerClassName={s.chip} trigger={<>Header: row {draft.headerRow}</>} role="menu">
              {(close) => Array.from({ length: INTAKE_LIMITS.headerSearch }, (_, i) => i + 1).map((n) => (
                <button key={n} type="button" role="menuitemradio" aria-checked={draft.headerRow === n} className={s.menuItem} onClick={() => { close(); void reread({ headerRow: n }); }}>Row {n}</button>
              ))}
            </Popover>
          </div>
          {draft.fileWarnings.map((w) => <p key={w.code} className={s.warn}>{w.message}</p>)}
          {draft.alreadyImported && (
            <p className={s.warn}>This file was already imported on {day(draft.alreadyImported.at)}{draft.alreadyImported.by ? ` by ${draft.alreadyImported.by}` : ""}. Importing it again merges every row, so nothing is duplicated.</p>
          )}
          <table className={s.sample}>
            <caption className={s.srOnly}>The first rows as LUME read them</caption>
            <thead><tr>{draft.headers.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>{draft.sample.map((r, i) => <tr key={i}>{draft.headers.map((_, c) => <td key={c}>{r[c]}</td>)}</tr>)}</tbody>
          </table>
          <div className={s.actions}>
            <Button variant="primary" onClick={onContinue}>Continue</Button>
          </div>
        </div>
      )}
    </section>
  );
}
```

`imports.module.css` holds the sheet frame (a large centred sheet, `min(1080px, 100vw - 32px)` wide, full height minus 32px, `var(--sheet)`, `var(--shadow-pop)`, radius 18px), the rail (numbered steps, the current one in `var(--accent-ink)` with a filled number), the drop zone (dashed hairline, `var(--sunk)`, `data-over` in `var(--accent-soft)`), chips, the sample table (sticky header, tabular numbers, cells truncated with ellipsis), `.problem` (`var(--danger-ink)`), `.warn` (`var(--warn-ink)` on `var(--warn-soft)`), `.ask` (a centred confirm card over a veil) and `.srOnly` — all tokens, both themes, no vendor prefixes; at ≤ 720px the rail becomes a horizontal scroller and the sheet fills the screen.

- [ ] **Step 5: Run to see it pass**

Run: `scripts/dev.sh run bash -c 'pnpm vitest run apps/web/src/components/imports'`
Expected: PASS for the File tests. (`ColumnsStep`, `RulesStep`, `PreviewStep` and `ProgressStep` exist as minimal components from here, each returning its heading, so the sheet compiles; Tasks 11–13 fill them in.)

- [ ] **Step 6: Gate, commit, push** — `feat(web): the Import sheet — choose a file and see how LUME read it`.

---

### Task 11: Columns — the mapping and unmatched values

**Files:**
- Create: `apps/web/src/components/imports/ColumnsStep.tsx`, `apps/web/src/components/imports/UnmatchedPanel.tsx`, `apps/web/src/components/imports/ColumnsStep.test.tsx`

**Interfaces:**
- Consumes: `DraftView` (`headers`, `sample`, `mapping`, `targets`, `analysis`, `problems`, `choices.fields`, `can`), `importsClient.patch`.
- Produces: `ColumnsStep({ draft, onDraft, onContinue, blocked })`; every edit sends the **whole** mapping to `PATCH` (the server re-analyses and returns the new `analysis` and `problems`), and a text edit (a new field's name) waits 400 ms after the last keystroke.

- [ ] **Step 1: Write the failing tests** (`ColumnsStep.test.tsx`)

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importsClient } from "@/lib/imports/client";
import { testDraft } from "@/lib/imports/test-draft";
import { ColumnsStep } from "./ColumnsStep";

vi.mock("@/lib/imports/client", () => ({ importsClient: { patch: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
beforeEach(() => vi.clearAllMocks());

describe("ColumnsStep", () => {
  it("shows each column with sample values and where it goes", () => {
    render(<ColumnsStep draft={testDraft()} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    const row = screen.getByRole("row", { name: /Mobile/ });
    expect(within(row).getByText("050 123 4567")).toBeInTheDocument();
    expect(within(row).getByRole("combobox", { name: "Mobile goes to" })).toHaveValue("phone");
  });

  it("sends the whole mapping when a column changes", async () => {
    vi.mocked(importsClient.patch).mockResolvedValue(ok(testDraft()));
    render(<ColumnsStep draft={testDraft()} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Email goes to" }), "ignore");
    const sent = vi.mocked(importsClient.patch).mock.calls[0]![1] as { mapping: { columns: { to: string }[] } };
    expect(sent.mapping.columns.map((c) => c.to)).toEqual(["field", "field", "ignore"]);
  });

  it("makes a new field from a column, only for someone who can", async () => {
    vi.mocked(importsClient.patch).mockResolvedValue(ok(testDraft()));
    render(<ColumnsStep draft={testDraft()} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Email goes to" }), "new_field");
    expect(screen.getByRole("textbox", { name: "New field's name" })).toHaveValue("Email");
    const { unmount } = render(<ColumnsStep draft={testDraft({ can: { assign: true, manageFields: false, manageTags: true } })} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    expect(within(screen.getAllByRole("combobox", { name: "Email goes to" })[1]!).queryByRole("option", { name: "New field…" })).toBeNull();
    unmount();
  });

  it("lists unmatched values with their counts, and maps, adds or empties each", async () => {
    const draft = testDraft({
      mapping: { columns: [{ column: 0, to: "field", field: "name" }, { column: 1, to: "field", field: "tier" }], createMissingTags: false },
      analysis: [{ column: 0, unmatched: [] }, { column: 1, unmatched: [{ value: "Platinum", rows: 12 }, { value: "Silver+", rows: 2 }] }],
      problems: [],
    });
    vi.mocked(importsClient.patch).mockResolvedValue(ok(draft));
    render(<ColumnsStep draft={draft} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    const panel = screen.getByRole("region", { name: "Values LUME doesn't recognise" });
    expect(within(panel).getByText("Platinum")).toBeInTheDocument();
    expect(within(panel).getByText("12 rows")).toBeInTheDocument();
    await userEvent.selectOptions(within(panel).getByRole("combobox", { name: "Platinum becomes" }), "add");
    expect((vi.mocked(importsClient.patch).mock.calls.at(-1)![1] as { mapping: { addOptions: Record<string, string[]> } }).mapping.addOptions).toEqual({ tier: ["Platinum"] });
    await userEvent.selectOptions(within(panel).getByRole("combobox", { name: "Silver+ becomes" }), "o-silver");
    const last = vi.mocked(importsClient.patch).mock.calls.at(-1)![1] as { mapping: { columns: { transform?: { valueMap?: Record<string, string | null> } }[] } };
    expect(last.mapping.columns[1]!.transform?.valueMap).toEqual({ "Silver+": "Silver" });
  });

  it("asks how to read an ambiguous date column, and locks Continue until it's answered", async () => {
    const draft = testDraft({
      mapping: { columns: [{ column: 0, to: "field", field: "name" }, { column: 1, to: "field", field: "lead_created_at" }], createMissingTags: false },
      analysis: [{ column: 0, unmatched: [] }, { column: 1, dateOrder: "conflict", unmatched: [] }],
      problems: [{ column: 1, code: "DATE_ORDER_NEEDED", message: "This column has dates like 13/03 and 03/13 — choose how to read them." }],
    });
    render(<ColumnsStep draft={draft} onDraft={vi.fn()} onContinue={vi.fn()} blocked />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByText(/choose how to read them/)).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Read dates in Date as" })).toBeInTheDocument();
  });

  it("names every field that's needed on every lead and has no column", () => {
    const draft = testDraft({ problems: [{ column: null, code: "REQUIRED_FIELD_UNCOVERED", message: "Tier is needed on every lead: map a column to it or choose a default." }] });
    render(<ColumnsStep draft={draft} onDraft={vi.fn()} onContinue={vi.fn()} blocked />);
    expect(screen.getByText(/Tier is needed on every lead/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to see them fail** — `scripts/dev.sh run bash -c 'pnpm vitest run apps/web/src/components/imports/ColumnsStep.test.tsx'`. Expected: FAIL.

- [ ] **Step 3: Implement.** `ColumnsStep` renders a table (`<table>` with a caption "Your columns") with one row per header:
  - the header (the row's accessible name);
  - three non-empty sample values from `draft.sample`;
  - a `<select aria-label="{header} goes to">` built from `draft.targets` grouped in `<optgroup>`s (Contact, Lead, Custom), plus "First name", "Last name", "Ignore", and "New field…" when `draft.can.manageFields`;
  - a transform line under the select when relevant:
    - a date target gets the `radiogroup` "Read dates in {header} as" (Day/Month, Month/Day, Year-first), shown whenever `analysis.dateOrder` is `conflict` or `ambiguous`, and marked as required when `conflict`;
    - a phone target gets "Default country" (the existing `CountryPicker`);
    - a multi-choice or tags target gets "Split on" (`, ;` / `|`);
    - a new field gets its name input "New field's name" (defaulting to the header) and a type select.

  Every change builds the next `Mapping` and sends it with `importsClient.patch(draft.id, { mapping })`, applying the response through `onDraft`. `UnmatchedPanel` (region "Values LUME doesn't recognise") lists, for each column whose `analysis.unmatched` isn't empty, each value with "{n} rows" and a `<select aria-label="{value} becomes">`:
  - for choice fields: the live options, "Add as a new option" (value `add`, only with `can.manageFields`) and "Leave empty" (value `empty`);
  - for stages: the pipeline's stages and "Leave empty";
  - for owners: the active people and "Use the owner rule";
  - for tags: a single "Create the missing tags" switch (only with `can.manageTags`) instead of per-value selects.

  Choosing an option writes `transform.valueMap[value] = option label`, `empty` writes `null`, and `add` appends to `mapping.addOptions[field]`. The problems of this step (codes owned by Columns, as listed in `ImportSheet`) show above the table as a list of `role="alert"` lines in LUME's words. Continue is disabled while `blocked`, and the reason is the first problem's message.

- [ ] **Step 4: Run to see them pass**, **Step 5: gate, commit, push** — `feat(web): match columns to fields, and settle every value LUME doesn't recognise before importing`.

---

### Task 12: Rules and Preview

**Files:**
- Create: `apps/web/src/components/imports/RulesStep.tsx`, `apps/web/src/components/imports/PreviewStep.tsx`, `apps/web/src/components/imports/RulesPreview.test.tsx`

**Interfaces:**
- `RulesStep({ draft, onDraft, onContinue, blocked })` sends the whole `Rules` with `patch`. `PreviewStep({ draft, onFix(step), onStarted(view) })` calls `importsClient.preview(draft.id)` on mount and `importsClient.start(draft.id)` on "Import {n} rows".

- [ ] **Step 1: Write the failing tests** (`RulesPreview.test.tsx`)

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importsClient } from "@/lib/imports/client";
import { testDraft } from "@/lib/imports/test-draft";
import { PreviewStep } from "./PreviewStep";
import { RulesStep } from "./RulesStep";

vi.mock("@/lib/imports/client", () => ({ importsClient: { patch: vi.fn(), preview: vi.fn(), start: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
beforeEach(() => vi.clearAllMocks());

describe("RulesStep", () => {
  it("defaults to Merge, recommended, and explains each choice in a line", () => {
    render(<RulesStep draft={testDraft()} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    const group = screen.getByRole("radiogroup", { name: "When a row matches an existing lead" });
    expect(within(group).getByRole("radio", { name: /Merge/ })).toBeChecked();
    expect(within(group).getByText(/fills only empty fields/)).toBeInTheDocument();
  });

  it("offers giving leads to others only with Assign, and saves the owner rule", async () => {
    vi.mocked(importsClient.patch).mockResolvedValue(ok(testDraft()));
    render(<RulesStep draft={testDraft()} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    await userEvent.click(screen.getByRole("radio", { name: "Take turns" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Riya Sharma" }));
    expect((vi.mocked(importsClient.patch).mock.calls.at(-1)![1] as { rules: { owner: unknown } }).rules.owner).toEqual({ mode: "round_robin", userIds: ["u-riya"] });
    render(<RulesStep draft={testDraft({ can: { assign: false, manageFields: true, manageTags: true } })} onDraft={vi.fn()} onContinue={vi.fn()} blocked={false} />);
    expect(screen.getAllByRole("radio", { name: "Take turns" })[1]).toBeDisabled();
  });

  it("asks for a default for each required field without a column", async () => {
    const draft = testDraft({ problems: [{ column: null, code: "REQUIRED_FIELD_UNCOVERED", message: "Tier is needed on every lead: map a column to it or choose a default." }] });
    render(<RulesStep draft={draft} onDraft={vi.fn()} onContinue={vi.fn()} blocked />);
    expect(screen.getByRole("combobox", { name: "Tier for every imported lead" })).toBeInTheDocument();
  });
});

describe("PreviewStep", () => {
  it("shows what each row will do, in words, with a summary", async () => {
    vi.mocked(importsClient.preview).mockResolvedValue(
      ok({
        rows: [
          { rowNumber: 2, outcome: "create", name: "Aisha Khan", mergeInto: null, alsoMatches: 0, problems: [], warnings: [] },
          { rowNumber: 3, outcome: "merge", name: "Omar", mergeInto: { visible: true, leadId: "l1", name: "Omar Haddad", ownerName: "Riya Sharma" }, alsoMatches: 0, problems: [], warnings: [] },
          { rowNumber: 4, outcome: "merge", name: "X", mergeInto: { visible: false }, alsoMatches: 0, problems: [], warnings: [] },
          { rowNumber: 5, outcome: "error", name: null, mergeInto: null, alsoMatches: 0, problems: [{ column: 2, code: "STAGE_UNKNOWN", message: "No stage called “Hot” in this pipeline." }], warnings: [] },
        ],
        summary: { create: 1, merge: 2, skip: 0, error: 1, empty: 0 },
      }),
    );
    render(<PreviewStep draft={testDraft()} onFix={vi.fn()} onStarted={vi.fn()} />);
    expect(await screen.findByText("1 create · 2 merge · 1 error")).toBeInTheDocument();
    expect(screen.getByText("Merges into Omar Haddad (Riya Sharma)")).toBeInTheDocument();
    expect(screen.getByText("Merges into an existing lead")).toBeInTheDocument();
    expect(screen.getByText("No stage called “Hot” in this pipeline.")).toBeInTheDocument();
  });

  it("starts the import, and a second press does nothing", async () => {
    vi.mocked(importsClient.preview).mockResolvedValue(ok({ rows: [], summary: { create: 0, merge: 0, skip: 0, error: 0, empty: 0 } }));
    vi.mocked(importsClient.start).mockResolvedValue(ok({ id: "i1", status: "queued" } as never));
    const onStarted = vi.fn();
    render(<PreviewStep draft={testDraft()} onFix={vi.fn()} onStarted={onStarted} />);
    const go = await screen.findByRole("button", { name: "Import 3 rows" });
    await userEvent.dblClick(go);
    expect(importsClient.start).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalled();
  });

  it("shows why Start was refused, and where to fix it", async () => {
    vi.mocked(importsClient.preview).mockResolvedValue(ok({ rows: [], summary: { create: 0, merge: 0, skip: 0, error: 0, empty: 0 } }));
    vi.mocked(importsClient.start).mockResolvedValue({ ok: false, status: 400, code: "MAPPING_INVALID", message: "That field no longer exists." });
    const onFix = vi.fn();
    render(<PreviewStep draft={testDraft()} onFix={onFix} onStarted={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Import 3 rows" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That field no longer exists.");
    await userEvent.click(screen.getByRole("button", { name: "Back to Columns" }));
    expect(onFix).toHaveBeenCalledWith("columns");
  });
});
```

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement.**

`RulesStep` is a form of four panels, each saving the whole `Rules` through `patch` on change:
1. **"How LUME recognises an existing lead"**:
   - three toggle chips in order, Phone, Email and Instagram, reorderable with Alt+←/→;
   - the `radiogroup` "When a row matches an existing lead", with one line each:
     - Merge (Recommended): "fills only empty fields, adds a note to its history, never overwrites";
     - Skip: "leaves it as it is";
     - Create a duplicate: "makes a second lead anyway".
2. **"Leads that come back"**: a switch "Reopen a closed lead" and, when on, the open stages to reopen to.
3. **"Where new leads go"**:
   - pipeline select (only when there are several pipelines);
   - entry stage select (open stages first);
   - the owner `radiogroup`: Unassigned; One person, with a select of active people; Take turns, with a checkbox per active person. The last two are disabled without `can.assign`, except that One person is allowed when you choose yourself.
4. **"Details"**:
   - default phone country (`CountryPicker`);
   - "Rows without a name": "Use their phone or email" or "Count as a problem";
   - "An owner LUME doesn't know": "Use the owner rule" or "Count as a problem";
   - one control per `REQUIRED_FIELD_UNCOVERED` problem, named "{field} for every imported lead", fitted to the field type (select for choices, input for text and number, `Switch` for yes/no), writing `requiredDefaults[key]`.

`PreviewStep`:
- **The summary** ("{n} create · {n} merge · {n} skip · {n} error · {n} empty", omitting zeros).
- **The rows**, as a table with columns Row, Outcome, Lead and Notes:
  - the Outcome is a chip: Create, Merge, Skip, Problem, Empty;
  - Merge reads "Merges into {name} ({owner})", "Merges into an existing lead", or "Merges into row {n}";
  - problems in `var(--danger-ink)` and warnings in `var(--text-2)`, both in LUME's words.
- **"Show rows with problems"**: calls `preview(id, { errorsOnly: true })`. The server scans the whole file and returns up to 20 rows with problems. The table swaps to them, under the line "LUME checked all {scanned} rows: {n} have problems" (or "no problems"), and "Back to the first rows" returns.
- **The primary button "Import {rowCount} rows"**: guarded by a `useRef` flag, so a double click sends one Start. A refusal shows `role="alert"` with the message and a "Back to Columns" or "Back to Rules" button, chosen by the refusal's first problem code.

- [ ] **Step 4: Run to see them pass**, **Step 5: gate, commit, push** — `feat(web): choose how duplicates and owners are handled, and see exactly what will happen before importing`.

---

### Task 13: Progress, the report, Settings → Imports, and finding imported leads

**Files:**
- Create: `apps/web/src/components/imports/ProgressStep.tsx`, `apps/web/src/components/imports/ProgressStep.test.tsx`, `apps/web/src/components/settings/ImportsList.tsx`, `apps/web/src/components/settings/ImportsList.test.tsx`, `apps/web/src/app/(app)/settings/imports/page.tsx`
- Modify: `apps/web/src/lib/settings/areas.ts` (area `imports`, `anyOf: ["leads.import"]`, group "workspace"), `apps/web/src/components/leads/LeadsScreen.tsx` (Import button + Done badge), `apps/web/src/lib/leads/filters.ts` + `apps/api/src/modules/leads/query.ts` + its test (a `source` filter), `apps/web/src/components/leads/FilterBar.tsx` (the "From {file}" chip)

**Interfaces:**
- `ProgressStep({ initial, onClose })` polls `importsClient.get(id)` every 2 s while `queued | running | cancelling`, and stops polling when the sheet unmounts.
- `GET /api/v1/leads?source=<uuid>` filters by `source_id`; the web URL param is `source`, shown as a removable chip "From leads-march.csv". The chip's name comes from the catalog: a new `GET /api/v1/sources` (permission `leads.view`) returns `{ sources: { id, name, type }[] }` of non-archived sources, `loadCatalog` adds `sources` to `Catalog`, and the route goes into `probes.ts`.
- The Done badge: `LeadsScreen` asks `importsClient.list()` once on mount (only for `leads.import` holders) and shows a dot on "Import" when any of the viewer's imports is `done | failed | stopped_access` with `seenAt === null`. Opening the report calls `importsClient.seen(id)`.

- [ ] **Step 1: Write the failing tests**

`ProgressStep.test.tsx`:

```tsx
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importsClient } from "@/lib/imports/client";
import { ProgressStep } from "./ProgressStep";

vi.mock("@/lib/imports/client", () => ({ importsClient: { get: vi.fn(), cancel: vi.fn(), resume: vi.fn(), seen: vi.fn() } }));
const view = (over = {}) => ({
  id: "i1", status: "running", fileName: "leads.csv", rowCount: 1000, cursorRow: 401,
  counts: { created: 380, merged: 15, skipped: 0, empty: 2, errors: 3, warnings: 10, nameFromContact: 4, missingStageFields: 0, phoneNeedsCountry: 6 },
  startedBy: { id: "u-maya", name: "Maya Kapoor" }, createdAt: "2026-09-27T09:00:00Z", startedAt: "2026-09-27T09:01:00Z",
  finishedAt: null, seenAt: null, stopReason: null, sourceId: "src1", canSeeRows: true, mine: true, ...over,
});
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe("ProgressStep", () => {
  it("shows live counts, tells the importer LUME will let them know, and polls until done", async () => {
    vi.mocked(importsClient.get).mockResolvedValueOnce(ok(view())).mockResolvedValueOnce(ok(view({ status: "done", cursorRow: 1001, counts: { ...view().counts, created: 970 }, finishedAt: "2026-09-27T09:03:00Z" })));
    render(<ProgressStep initial={view() as never} onClose={vi.fn()} />);
    expect(screen.getByText("You can close this — LUME will let you know when it's done.")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Rows done" })).toHaveAttribute("aria-valuenow", "400");
    await act(async () => vi.advanceTimersByTimeAsync(4100));
    expect(await screen.findByRole("heading", { name: "leads.csv is in LUME" })).toBeInTheDocument();
    expect(screen.getByText("970 created")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download the 3 rows with problems" })).toHaveAttribute("href", "/api/v1/imports/i1/errors.csv");
    expect(screen.getByRole("link", { name: "View imported leads" })).toHaveAttribute("href", "/leads?source=src1");
    expect(importsClient.seen).toHaveBeenCalledWith("i1");
  });

  it("cancels, and offers to import the rest", async () => {
    vi.mocked(importsClient.cancel).mockResolvedValue(ok(view({ status: "cancelling" })));
    vi.mocked(importsClient.get).mockResolvedValue(ok(view({ status: "cancelled", stopReason: "cancelled" })));
    render(<ProgressStep initial={view() as never} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    await act(async () => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByText(/Cancelled after row 400/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import the rest" })).toBeInTheDocument();
  });

  it("explains an import stopped because access changed", async () => {
    render(<ProgressStep initial={view({ status: "stopped_access", stopReason: "access_changed" }) as never} onClose={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("LUME stopped this import because your access changed");
  });
});
```

`ImportsList.test.tsx`: lists imports newest first with status words ("Done", "Draft — continue", "Stopped: access changed", "Cancelled", "Failed"), counts, who and when; a draft row's "Continue" opens the sheet with that `draftId`; a finished row opens its report; "Load more" pages with the cursor.

`query.ts` test (in `apps/api/src/modules/leads/list.test.ts`, beside the other filter tests): `GET /api/v1/leads?source=<id>` returns only leads with that `source_id`; an invalid uuid is `400`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement.**

**`ProgressStep`, while running:**
- the heading "Importing {file}";
- a progress bar (`role="progressbar"`, name "Rows done", value = created + merged + skipped + empty + errors, max = `rowCount`) drawn as a ring in `var(--accent)`;
- live count chips;
- the line "You can close this — LUME will let you know when it's done.";
- "Cancel import".

**At `done`:**
- the heading "{file} is in LUME";
- the count lines: "{n} created", "{n} merged into existing leads", "{n} skipped", "{n} empty rows", "{n} with problems", "{n} used the contact as the name", "{n} need a country code for their phone", "{n} are missing fields their stage asks for";
- the links "View imported leads" (`/leads?source={sourceId}`) and "Download the {n} rows with problems" (shown when errors > 0 and `canSeeRows`; a plain `<a href download>` to `errors.csv`, since a GET needs no CSRF token);
- a note on fix-and-retry: "Fix them in your spreadsheet and import that file — rows already in LUME merge, so nothing doubles."

**At `cancelled`:** "Cancelled after row {cursorRow − 1}", then "Import the rest" (`resume`, back to polling).

**At `stopped_access`:** `role="alert"` "LUME stopped this import because your access changed. Ask an admin, then import the rest."

**At `failed`:** `role="alert"` "LUME couldn't finish this import: {reason}", then "Try again" (`resume`).

**Polling:** a `setTimeout` chain (not an interval), cleared on unmount. Calls `seen` once on reaching a terminal state.

**No sound** (sounds are for achievements only, and a finished import is administrative, not an achievement).

`ImportsList` + page per the interface; `areas.ts` gains:

```ts
  {
    id: "imports",
    title: "Imports",
    blurb: "Past imports, their reports, and drafts to finish",
    href: "/settings/imports",
    anyOf: ["leads.import"],
    group: "workspace",
  },
```

`LeadsScreen`: an "Import" button (secondary, in the toolbar's second row beside Columns, only when `can(session.actor, "leads.import")`) opening `ImportSheet`; it wears the badge dot (`aria-label="Import — a finished import to look at"` when shown). Opening Settings → Imports → a finished import shows its report (the same `ProgressStep` in its done state) in the sheet.

- [ ] **Step 4: Run to see them pass**, **Step 5: gate, commit, push** — `feat(web): watch an import, read its report, find its leads, and come back to it in Settings`.

---

### Task 14: End to end, accessibility and screenshots

**Files:**
- Create: `apps/web/e2e/imports.spec.ts`, `apps/web/e2e/fixtures/brightpath-leads.csv`, `apps/web/e2e/fixtures/brightpath-leads-semicolon.csv`
- Modify: `apps/web/e2e/a11y.spec.ts`, `apps/web/e2e/visual.spec.ts`

The fixtures are fictional (Brightpath Studio): `brightpath-leads.csv` has 12 rows:
- a title line above the header;
- headers `Full name, Mobile, Email, Date, Stage, Tier`;
- phones in four formats;
- two rows repeating an existing seeded lead by phone;
- one repeated within the file;
- one unknown stage "Hot lead";
- one empty row;
- one Excel-shortened number.

`brightpath-leads-semicolon.csv` is the same data saved the European way (semicolons, `dd.mm.yyyy`, comma decimals).

- [ ] **Step 1: Write the specs** (`imports.spec.ts`), each putting back what it changed (delete the created leads through the API in `finally`, as `settings.spec.ts` does):
  - `@smoke import a CSV end to end`:
    - open Leads → Import;
    - upload the fixture: "Header: row 2" is detected;
    - Columns: every suggestion is right, and "Hot lead" is listed as unmatched. Map it to "Qualified" (the General preset's stage);
    - Rules: defaults;
    - Preview: the summary reads the expected counts, and "Merges into {seeded lead}" shows;
    - Import: wait for "{file} is in LUME";
    - "View imported leads" shows the new leads with the "From brightpath-leads.csv" chip;
    - the seeded lead's history shows "Enquired again".
  - `the European file reads right`: after upload, the Preview shows the amounts and dates read correctly (a row whose value is `1.234,50` → "AED 1,234.50" in the created lead).
  - `@smoke a rep without Import leads sees no Import button` (stateFile `seller`).
  - `cancel and import the rest`: a 600-row generated fixture (written to a temp file in the test); Cancel during the run; "Import the rest"; done.
  - `@smoke the bulk phone fix`: filter leads by "Needs code", select them, "Set country…", choose the UAE; the summary names fixed and skipped leads.

- [ ] **Step 2: Accessibility and screenshots.** In `a11y.spec.ts`, add checks for each import step (File with a file read, Columns with the unmatched panel, Rules, Preview, the finished report) and for Settings → Imports, in both themes. In `visual.spec.ts`, add screenshots of Columns, Preview and the report in both themes.

- [ ] **Step 3: Run the whole e2e suite**, `--update-snapshots=missing` for the new baselines; fetch them; **open and review every new image**; then run once more with no updates, and it must be all green.

Run: `scripts/dev.sh run bash -c 'cd apps/web && pnpm exec playwright test --update-snapshots=missing'` then `scripts/dev.sh run bash -c 'cd apps/web && pnpm exec playwright test'`
Expected: all pass on the second run with no snapshot writes.

- [ ] **Step 4: Gate, commit, push, watch CI** — `test(web): imports end to end, accessibility and screenshots`.

---

### Task 15: Live acceptance, docs and memory

- [ ] **Step 1: `apps/web/e2e-live/acceptance-2a.mjs`**, run after `acceptance-1c1.mjs` in the same container, with `ACCEPT_STATE_DIR`, `PLAYWRIGHT_BROWSERS_PATH=/pnpm-store/ms-playwright` and `-v lumedev_pnpm_store:/pnpm-store` (as in the 1C-3 runbook). It uploads a generated 500-row messy file through the UI (the §11 mix), and checks each of these:
  - Preview;
  - Import to done;
  - the counts;
  - zero duplicate leads (through the API);
  - re-importing the same file creates nothing;
  - a shuffled copy creates nothing;
  - the report's failed-rows download;
  - the bulk phone fix on the "Needs code" leads;
  - Settings → Imports.

  Screenshots go to `docs/runbooks/screenshots-2a/`. Also re-run 1C-1 … 1C-3 in the same container, so their screenshots show Brightpath Studio instead of the old names.
- [ ] **Step 2:** Reset the dev database (`scripts/dev.sh reset-db`) so the owner does the first run.
- [ ] **Step 3:** A "Phase 2A — CSV import" section in `docs/runbooks/acceptance.md` (checks, screenshots, counts, CI link, findings), and execution notes at the end of this plan.
- [ ] **Step 4:** Memory `lume-progress`: 2A done; next 2B (Google Sheets, a per-instance integration toggle).
- [ ] **Step 5:** Gate, commit, push — `docs: Phase 2A acceptance on the dev stack`; watch CI to green.

---

## Self-review (2026-09-27)

**Spec coverage.** Every section is implemented by a task:

| Spec section | Task |
|---|---|
| §3 permissions | 6, 7, 13 |
| §4.1–4.4 tables | 4 |
| §4.5 access (amendment 5) | 4 |
| §4.6 retention | 9 |
| §5.1 reading | 1 |
| §5.2 suggestions (amendment 4) | 3 |
| §5.3–5.4 mapping and rules | 3 |
| §5.5 and §6.1–6.8 row rules | 2, 3 |
| §6.9 duplicates and merging | 5, 7 |
| §6.10 creating (amendment 2) | 5, 7 |
| §6.11 preview | 6 |
| §6.12 report | 7, 13 |
| §6.13 bulk fix | 8 |
| §6.14 required fields (amendment 3) | 3, 12 |
| §7 job (amendment 1) | 7 |
| §8 API | 6, 7, 8, 10 |
| §9 automations | 7 (`imported` activity type) |
| §10 screens | 10–13 |
| §11 testing | 1–14 |
| Live acceptance | 15 |
| `CLAUDE.md` client-neutral rule | 0 |

**Placeholder scan.** No step says "handle errors" without the handling. Tasks 11–13 describe their component markup in prose where the markup is conventional. Their behaviour is pinned by full test code, and every name the tests use is given.

**Type consistency.** These names are used identically across Tasks 3, 6, 7 and 10–13: `Mapping` (with `addOptions?` and `createMissingTags`), `Rules` (with `requiredDefaults`), `MapContext`, `LeadDraft`, `RowOutcome`, `Issue`, `ColumnAnalysis`, `DraftView`, `PreviewRow`, `ImportView`, `insertLead`, `mergeFill`, `mergeIntoLead`, `withJobRequest`, `loadMapContext`, `findMatches`, `contactHashes`, `runImport` and `startImportQueue`.

**Review Focus.** Each of the five lines has its test:
1. Task 2: the semicolon/comma-decimal case.
2. Task 7: the same number written two ways.
3. Task 7: Start re-validates.
4. Task 7: Start twice runs once, plus Task 12's double-click guard.
5. Task 6: the anonymous merge.
