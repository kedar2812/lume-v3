# Phase 6B — Exports you can trace: watermarked lead exports, the Exports list, Trace a file — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native). Steps use checkbox (`- [ ]`) syntax for tracking. Tests are described in prose and written in full, first (standing ruling since 3B).

**Goal:** people with `leads.export` can export the current Leads view (its filters and its columns) as CSV or Excel. Every file carries a mark that traces it back to its export: a `LUME ref` code on every row, and one made-up check row. Files expire after 24 hours, and every download is audited. Settings → Security gains **Exports**: Trace a file (drop a CSV or Excel file, or type a code) and the list of exports. Built to the owner's canvas https://claude.ai/artifact/M8FauNrEgtF9T62PkF69ka, board [Exports].

**Architecture:**
- **Making the file:** the API makes it in the request, reusing the Leads list's own filters (`leadFilters`, so row-level security and field access apply exactly as on screen) and the whole-instance export's cell safety (`safeCell`: no live formulas). CSV through Papa Parse; Excel through ExcelJS.
- **Storing the file:** sealed with the instance keyring (as import files are) in `lead_exports.file_enc`, in the instance's own database. Nothing is sent anywhere. An hourly tick clears files older than 24 hours and keeps the row.
- **The check row:** a made-up lead, generated at random per export and stored with it: a name from a fixed list, an email at `example.invalid` (reserved by RFC 2606, so it can never receive mail), and a phone in Ofcom's fiction range +44 7700 900000–900999. It sits at a random position in the file.
- **Trace:** read on the server, in memory, and never kept. It looks for a `LUME ref` column first, then for any stored check-row email or phone anywhere in the file.
- **Intake:** a row whose email is at `example.invalid` is refused with its own words, so an export brought back into LUME never makes its check row a lead. The `LUME ref` header maps to "ignore".

**Tech Stack:** Fastify, Postgres, Zod, ExcelJS, Papa Parse, Next.js, React, motion/react, CSS modules, vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-01-phase-6-anti-exfiltration-design.md` §3.

## Rulings taken while planning (cost if wrong)

- **B1. In the request, not a queue.** The file is made while the person waits, capped at 25,000 leads (more gives "Narrow the view: up to 25,000 leads in one file"). The spec said "by the worker"; a CSV of 25,000 rows takes well under a second, and a queue adds a waiting screen for no gain. Cost if wrong: a later queue for bigger exports.
- **B2. Sealed in the database.** The file is stored like import files, encrypted with the keyring in `lead_exports.file_enc`, rather than on a disk volume. It survives restarts, needs no volume, and is removed by the expiry tick. Cost if wrong: the database grows by one file per export for 24 hours.
- **B3. The check row is random and stored,** not derived from the code. Trace then looks it up by equality, with no secret derivation to get right. The phone range has only 1,000 numbers, so the email (with a random tag) is the reliable mark; a phone match counts only when it names a single export. Cost if wrong: none meaningful.
- **B4. The label is the view's name,** sent by the browser ("Hot leads", or "All leads"); the filters are stored as given. Trace says "Maya Kapoor's export · Hot leads · 128 leads · CSV". Cost if wrong: an odd label if the browser lies, while the filters and the audit stay true.
- **B5. Who sees what.** The export sheet downloads the file at once. The Exports list and Trace live in Settings → Security (`security.manage`). A file is downloaded only by the person who made it, while it lasts. Cost if wrong: an admin can't fetch someone else's file, which is the point.
- **B6. A check row brought back into LUME** is refused as a row problem: "A LUME export's check row: not a real lead". It shows in the import's problems, and in a sheet's or webhook's failed rows, with that reason. Cost if wrong: it reads as a problem rather than a quiet skip.

## Global Constraints

- **The promise, said exactly** (spec §3), on screen and in the docs: a file that still has the code column or the check row traces to its export; one where both were removed, or the rows were retyped, can't be traced, and Trace says "No LUME export matches this file" without guessing.
- **The code** is 8 characters as `XXXX-XXXX`, from an alphabet without look-alikes (no 0, O, 1, I, L), and unique.
- **Never more than the person could see:** the exporter's own row-level security, masked contacts for a masked exporter, and hidden fields left out.
- **Cell safety:** every cell goes through `safeCell`.
- **Copy speaks as LUME.** Dates are month first. Every control works by keyboard. Reduce Motion gets cross-fades. No sound.
- **Generic data only.** Tests run on the dev box; push per task; read CI; keep the ledger current.

## Review Focus

1. **Field access and scope in the file.** A team-scoped exporter's file holds only their team's leads; a hidden field never appears as a column even if the browser asks for it; a masked exporter gets masked contacts. (Task 2 tests.)
2. **Trace robustness.** Excel and CSV, a file with `LUME ref` deleted and rows re-sorted, a semicolon CSV, a file with extra columns in front, a code typed with or without the dash or in lower case, and a file that isn't a spreadsheet ("LUME can't read this file", never a crash). (Task 3 tests.)
3. **Expiry.** A download after 24 hours gives 410 with "This file has expired"; the tick clears the file and keeps the row; the list says "Expired". (Task 2 tests.)
4. **Formula safety.** A lead named `=HYPERLINK(...)` is written with a leading `'` in both CSV and Excel. (Task 2 test.)
5. **The check row going back in.** A CSV import of an export creates every real lead, refuses the check row with its words, and ignores the `LUME ref` column. (Task 4 test.)

---

### Task 1: Data — the exports table and the code

**Files:** new `packages/db/migrations/0043_lead_exports.sql`; `packages/db/src/schema/security.ts` (`leadExports`); new `packages/core/src/security/export-code.ts` (+test), exported from core; schema drift.

- **Table** `lead_exports`:
  - `id`, `user_id`, `code char(9) UNIQUE`, `label text`, `format text` (`csv | xlsx`), `filters jsonb`, `columns text[]`, `row_count int`;
  - `check_name`, `check_email` (unique), `check_phone`, `check_position int`;
  - `file_enc bytea` (null once cleared), `downloads int default 0`, `last_downloaded_at`, `created_at`, `expires_at`, `cleared_at`.
- **Indexes:** `(created_at DESC)`, `(check_phone)`. GRANT SELECT, INSERT, UPDATE to lume_app.
- **Core helpers:**
  - `newExportCode(random)` gives `XXXX-XXXX`;
  - `normaliseCode(input)` gives `XXXX-XXXX` or null (dash optional, case-insensitive);
  - `checkRow(random)` gives `{ name, email, phone }` (the name from fixed generic first/last lists; email `first.last.<6 hex>@example.invalid`; phone `+44 7700 900ddd`);
  - `isCheckEmail(email)`.
- [ ] **Tests first:**
  - the code's form and alphabet;
  - `normaliseCode("lx7q4mra")` gives `LX7Q-4MRA`, and garbage gives null;
  - the check row's three formats;
  - `isCheckEmail` is true only for `@example.invalid`;
  - the migration's constraints in a db test.
- [ ] **RED → implement → GREEN →** full suite, commit, push, CI, ledger.

### Task 2: Making, listing, downloading and expiring exports (API)

**Files:** new `apps/api/src/modules/exports/{make,service,routes}.ts` (+tests), registered in `app.ts`; the expiry tick in `tasks/queue.ts` (hourly); probes in `test/probes.ts`.

**Routes:**

| Route | Permission | What |
|---|---|---|
| `POST /api/v1/leads/export` | `leads.export` | `{ format, label, filters, columns }`. The filters are the list's query shape, and the columns are the screen's column ids, filtered to those the person may see. Makes the file and seals it, then audits `lead.export` with `{ code, rows, format, label }`. Gives `{ export: ExportView }`. 422 for `NOTHING_TO_EXPORT`, and 422 for `TOO_MANY` above 25,000 |
| `GET /api/v1/leads/exports` | `security.manage` | the last 90 days, newest first, as `ExportView` (`who`, `label`, `format`, `rows`, `code`, `createdAt`, `expiresAt`, `available`, `downloads`) |
| `GET /api/v1/leads/exports/:id/download` | `leads.export`, the maker only | the file as an attachment, named `LUME leads <Mon D> <code>.csv/.xlsx`. Increments `downloads` and audits `lead.export.download`. 410 `EXPIRED` once cleared or past `expires_at`; 404 for anyone else's |

**The file:**
- columns in the screen's order, then `LUME ref` last; the code on every row;
- the check row inserted at `check_position` (random in 0..rows);
- Excel as one sheet, "Leads", with a bold header.

**The expiry tick:** hourly, `UPDATE lead_exports SET file_enc = NULL, cleared_at = now() WHERE file_enc IS NOT NULL AND expires_at < now()`.

- [ ] **Tests first** (HTTP, with a harness admin, a team lead with `leads.export` at team scope, and a masked exporter):
  - CSV round-trip: the header row and real rows; `LUME ref` on every row; exactly one check row at its position, with `@example.invalid`;
  - an Excel file read back with ExcelJS holds the same;
  - Review Focus 1, 3 and 4;
  - zero rows gives 422 and makes no row;
  - more than 25,000 gives 422 (with the cap lowered through an option for the test);
  - someone else's download gives 404;
  - the audit rows;
  - the probes in the access matrix.
- [ ] **RED → GREEN →** full suite, commit, push, CI, ledger.

### Task 3: Trace a file (API)

**Files:** new `apps/api/src/modules/exports/trace.ts` (+test); a route in `exports/routes.ts`; probes.

- **`POST /api/v1/security/trace`** (`security.manage`) takes either a raw file body (≤10 MB, `x-file-name`, as the import upload does) or JSON `{ code }`.
  - CSV is read with core's `readCsv`, which sniffs delimiter and encoding; `.xlsx` with ExcelJS (first sheet).
  - It finds a `LUME ref` column (header match, case-insensitive) and takes its codes. Otherwise it collects every cell's emails and phones (normalised to digits) and looks up `check_email = ANY` or `check_phone = ANY`. A phone counts only when it matches one export.
- **Answer:** `{ match: null }` or `{ match: { code, who, createdAt, label, rows, format, foundBy: "column" | "check_row", downloads: [{ at, device }] } }` (downloads from the audit, with device names).
- **Audit:** `security.trace`, with `{ found: code | null }`. Never the file and never its contents.
- [ ] **Tests first:**
  - Review Focus 2, all of it;
  - a file mixing two exports' codes gives the first;
  - a 10 MB+ body gives 413;
  - a person without `security.manage` gives 403;
  - the file isn't kept anywhere (no row grows).
- [ ] **RED → GREEN →** suite, commit, push, CI, ledger.

### Task 4: A check row never becomes a lead (intake)

**Files:** `packages/core/src/intake/map-row.ts` (+test), `packages/core/src/intake/mapping.ts` (+test); an imports test in the API.

- **`mapRow`:** a draft whose email `isCheckEmail` gives `{ kind: "error", problems: [{ code: "LUME_CHECK_ROW", message: "A LUME export's check row: not a real lead" }] }` (B6).
- **`suggestMapping`:** a header `LUME ref` (any case or spacing) gives `ignore`, even against a remembered mapping.
- [ ] **Tests first:** the two core tests, and Review Focus 5 through the import API (upload an export's CSV, map, run: the real leads are created; the problems list holds the check row with its words).
- [ ] **RED → GREEN →** suite, commit, push, CI, ledger.

### Task 5: Export on the Leads list, and Security → Exports [Exports]

**Files:**
- **Export:** new `components/leads/ExportSheet.tsx` (+test); `LeadsScreen.tsx` (an "Export" button beside Import, for `leads.export`); `lib/leads/client.ts` (`exportView`);
- **Security → Exports:** new `components/settings/security/{ExportsTab,TraceFile,ExportList}.tsx` (+tests); `app/(app)/settings/security/exports/page.tsx`; `tabs.ts` (Exports after Access limits); `lib/settings/security.ts` (the client);
- review copies in `e2e/security.spec.ts` (extended).

**Design:**
- **Export sheet:**
  - "Export {view name}": "{n} leads · {k} columns"; CSV or Excel (option cards);
  - the promise in one line: "Each file carries a mark that traces it back to you. It's deleted after 24 hours.";
  - **Export** makes it, then the button becomes **Download** with a check pop (no sound), and the download starts at once;
  - errors in LUME's words (Narrow the view …, Nothing to export).
- **Trace [Exports]:**
  - "Where did this file come from?";
  - a drop zone ("Drop a CSV or Excel file here · LUME reads it and forgets it. Nothing is kept.") with **Choose a file**;
  - while reading, "Reading {file}…" with an indeterminate bar;
  - **found:** a card with the person, "{Name}'s export", "{date}, {time} · code {CODE}", What ("{label}, {n} leads, as CSV"), Downloaded (each, with its device), Found by ("The LUME ref column", or "A hidden check row. Someone deleted the LUME ref column, but the row stayed."), **Open the audit log** and **Check another file**;
  - **none:** "No LUME export matches this file · It may have been copied by hand, or come from somewhere else.";
  - "Or type the code from its LUME ref column" with **Look it up**; and "How the mark works" text from the canvas, exactly.
- **Exports list:** "Files disappear 24 hours after they're made. Every download is recorded." Each row: who, what ("Hot leads · 128 leads · CSV"), when, downloads, the code (mono), and the time left or "Expired"; Download for your own live export.
- [ ] **Tests first** (Testing Library):
  - the sheet sends the view's filters, columns and label; Download fetches the file;
  - Trace shows found-by-column, found-by-check-row and none, and the code lookup normalises;
  - the list's states;
  - the e2e: export the current view as CSV and as Excel; trace each, with the column and with it removed; review copies in both themes; axe.
- [ ] **RED → GREEN →** web suite, e2e, review copies read, design findings fixed, commit, push, CI, ledger.

### Task 6: Words, docs, review

- [ ] Audit words for `lead.export`, `lead.export.download` and `security.trace` (test first).
- [ ] `docs/runbooks/security.md` gains Exports and Trace (the promise, exactly); add the acceptance section and the changelog.
- [ ] One fresh reviewer (the most capable model) over the whole 6B diff, then one fix pass; close the ledger with "Final review".
