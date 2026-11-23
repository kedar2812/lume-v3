# Storage and Clean up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings › Storage shows what LUME keeps on the server's disk, suggests a clean-up when it fills, and clears what the admin ticks (with the Refresh-morph animation), never anything a lead still needs.

**Architecture:** A `storage` API module measures the file store (whatsapp_files, which WhatsApp media, Instagram media and photos, previews and the file library all point at, refs kept by triggers) and the database, and works out exactly how many bytes each clean-up kind would free (a file counts only when every reference to it is in the cleared set). Clean up runs as one background job at a time in batches, records its progress in a table the web reads, and ends by running the existing file sweep so the space comes back at once. The web page is a Settings page in the real frame; Clean up uses the Refresh morph.

**Tech Stack:** Fastify, Drizzle, Postgres (FORCE RLS), pg-boss, Next.js, motion, vitest, Playwright.

**Spec:** Owner-approved canvas https://claude.ai/artifact/Xfjnt1veeiGTAiPhQTpbr7 (Main.dc.html, scenes page / suggestion / clean up / cleaning) and `.superpowers/sdd/2026-11-23-storage/progress.md` (survey and design).

## Global Constraints

- Who: only people with `settings.manage` see the page, the API and the suggestion.
- Never cleared: lead details, notes, tasks, the words of any message, files on open leads (not won, not lost, not trashed), files on leads closed more recently than the chosen months.
- A cleared chat file stays as a message saying so (WhatsApp: status `removed` with words; Instagram: the same, new status `removed`).
- One clean-up at a time; batches of 1000 rows per transaction; audited (`storage.cleaned`, with kinds, files and bytes).
- Suggest at the admin's mark, default 80% (choices 70/80/90), at most once a day, as a notification with a link to `/settings/storage`.
- Copy speaks as LUME, no em dashes, no guessed pronouns; sizes as `20.7 GB` / `830 MB` (one decimal over 1 GB); counts with Indian grouping (`12,410`).
- UI: the app's Settings frame (SettingsPage + SettingsNav), the Refresh morph for Clean up (button → glass pill → card where file tiles lift and come apart while the disk drains → tick → "✓ 20.7 GB back"), Reduce Motion gets the still card. Nothing overflows at 375, 768, 1280, 1440 widths in both themes (owner 2026-11-23).
- Lead data never leaves the server: the file list ("List the files first") downloads from this LUME only.

## Review Focus

1. A file shared by an open lead and a closed lead (same bytes forwarded twice): ticking "closed" must not count or clear its bytes, and the open lead keeps its file.
2. A file attached again while Clean up runs (a new message with the same bytes): it must not be deleted from disk (refs above zero at the sweep; the sweep's row lock).
3. Two admins pressing Clean up at once: one job runs, the other is told it is already running and watches the same progress.
4. A disk whose numbers can't be read (statfs fails, the store on a network mount): the page shows the kinds and their sizes, and says the disk's total isn't known, without a broken bar.
5. Hundreds of thousands of files: the survey answers within 2 s (one grouped query per kind, indexes below, cached 5 minutes) and the job never holds a transaction over 1000 rows.

---

## File Structure

- `packages/db/migrations/0126_storage.sql`: `file_previews.opened_at`, `instagram_media` status `removed`, `storage_cleanups` table, indexes for the candidate queries.
- `packages/db/src/schema/storage.ts` (+ index export): `storageCleanups`; `filePreviews.openedAt`.
- `packages/core/src/storage/index.ts`: kinds, labels, size formatting shared by API and web.
- `apps/api/src/modules/storage/survey.ts`: measure the disk, the kinds and each clean-up candidate.
- `apps/api/src/modules/storage/clean.ts`: the clean-up job.
- `apps/api/src/modules/storage/suggest.ts`: the hourly suggestion.
- `apps/api/src/modules/storage/routes.ts`: the routes; registered in `app.ts`; queue `storage.cleanup` in `packages/core/src/queues.ts`.
- `apps/web/src/app/(app)/settings/storage/page.tsx`, `apps/web/src/components/settings/storage/{StoragePage,CleanUpSheet,CleanUpMorph}.tsx` + `storage.module.css`, `apps/web/src/lib/settings/storage.ts` (client and types), `areas.ts` entry.

---

### Task 1: Measure what's there (survey)

**Files:**
- Create: `packages/db/migrations/0126_storage.sql`, `packages/db/src/schema/storage.ts`, `packages/core/src/storage/index.ts`, `apps/api/src/modules/storage/survey.ts`, `apps/api/src/modules/storage/routes.ts`
- Modify: `packages/db/src/schema/index.ts`, `apps/api/src/app.ts`, `apps/api/test/probes.ts`, `apps/api/test/rls-coverage.test.ts`, `apps/api/src/modules/media/routes.ts` (stamp `opened_at` when a preview is served)
- Test: `apps/api/src/modules/storage/survey.test.ts`, `packages/core/src/storage/index.test.ts`

**Interfaces:**
- Produces: `CLEAN_KINDS = ["closed", "trash", "previews", "library", "old"] as const`; `type CleanKind`; `CLOSED_MONTHS = [3, 6, 12, 24]`; `sizeText(bytes: number): string`; `countText(n: number): string` (core).
- Produces: `survey(pool: pg.Pool, files: FilesDeps | undefined, o: { closedMonths: number; now: Date }): Promise<Survey>` where `Survey = { disk: { total: number; free: number } | null; kinds: { key: "whatsapp" | "instagram" | "previews" | "library" | "database"; bytes: number; files: number }[]; other: number | null; candidates: { kind: CleanKind; bytes: number; files: number }[]; measuredAt: string }`.
- Produces: `GET /api/v1/storage?closedMonths=6` (settings.manage) → `Survey & { settings: { keepFilesMonths: 3|6|12|24|null; warnAtPct: 70|80|90 }; running: CleanupView | null }`.

Migration 0126: `ALTER TABLE file_previews ADD COLUMN opened_at timestamptz NOT NULL DEFAULT now()`; `instagram_media` status check adds `'removed'` (sha256 null when removed, as WhatsApp); `CREATE TABLE storage_cleanups (id uuid PK, kinds text[] NOT NULL, closed_months int, status text CHECK IN ('running','done','failed'), files_planned int, bytes_planned bigint, files_done int DEFAULT 0, bytes_done bigint DEFAULT 0, started_by uuid REFERENCES users, started_at, finished_at, problem text)` with a unique partial index `WHERE status = 'running'`; indexes `leads (won_at)`, `leads (lost_at)`, `leads (deleted_at) WHERE deleted_at IS NOT NULL` (only those missing), `whatsapp_media (lead_id) WHERE status = 'ready'`, `file_previews (opened_at)`. storage_cleanups is configuration-like bookkeeping (no lead data): no RLS, listed in rls-coverage.

Bytes freed rule (the algorithm the tests pin): a candidate's bytes are `SUM(f.size)` over `whatsapp_files f` where the number of the candidate's references to `f.sha256` equals `f.refs` (every reference to the file is in the cleared set). Files are counted per sha256 once. Kinds sum across candidate kinds only when ticked together; the API returns each kind alone, and the web adds them (a file in two ticked kinds may be counted twice in the total shown: the job reports the real freed bytes; note this in the sheet total as "about").

- [ ] **Step 1: Write the failing tests** (`survey.test.ts`, seeding files through the store and rows directly):
  - `it("counts each file once, in the first kind that points at it, and the database")`: WhatsApp files of 1 MB and 2 MB, an Instagram file of 3 MB, and a 4 MB file both a WhatsApp message and an Instagram message point at → `whatsapp = { bytes: 7 MB, files: 3 }`, `instagram = { bytes: 3 MB, files: 1 }` (order: whatsapp, instagram, previews, library); `database.bytes > 0`.
  - `it("closed: files on leads won or lost over N months ago, never one an open lead also has")`: a closed-7-months lead with file A (1 MB) and file B (2 MB), an open lead also holding B → `candidates.closed = { bytes: 1 MB, files: 1 }`; with `closedMonths: 12` → 0.
  - `it("trash, previews not opened in 90 days, archived library files no template uses, and every chat file over 12 months")`: one each, sizes 1/2/3/4 MB → each candidate's bytes and files; an archived library file a template header uses is not counted.
  - `it("a disk LUME can't read: kinds and candidates still answer, disk and other are null")`.
  - `it("only settings.manage")`: a rep gets 403; probes entry `GET /api/v1/storage` access `settings.manage`.
  - core: `sizeText(0) === "0 MB"`, `sizeText(830 * 2**20) === "830 MB"`, `sizeText(20.74 * 2**30) === "20.7 GB"`, `countText(12410) === "12,410"`, `countText(1234567) === "12,34,567"`.
- [ ] **Step 2: Run them, see them fail** (`npx vitest run apps/api/src/modules/storage packages/core/src/storage`).
- [ ] **Step 3: Implement** migration, schema, core helpers, `survey()` (one grouped query per kind under `lead_scope = all`, results cached 5 minutes per `closedMonths` in the module), the route, `opened_at` stamping in the preview-serving route (an UPDATE only when older than a day, so a busy file doesn't write on every view).
- [ ] **Step 4: Run them, see them pass**; mutate the "every reference in the set" rule and the template exclusion: both killed.
- [ ] **Step 5: Commit** `feat(storage): measure what LUME keeps on the disk`.

### Task 2: Clean up (the job)

**Files:**
- Create: `apps/api/src/modules/storage/clean.ts`
- Modify: `apps/api/src/modules/storage/routes.ts`, `packages/core/src/queues.ts` (+ its test), `apps/api/src/main.ts`, `apps/api/test/harness.ts` (`runStorageCleanup()`), `apps/api/src/modules/whatsapp/keep.ts` (export `deleteUnused`-driven `sweepWhatsAppFiles` option `{ minAgeMs }`)
- Test: `apps/api/src/modules/storage/clean.test.ts`

**Interfaces:**
- Consumes: `survey`, `CLEAN_KINDS`, `CLOSED_MONTHS` (Task 1); `sweepWhatsAppFiles(o)` (existing, gains `minAgeMs?: number`, default 3 600 000).
- Produces: `POST /api/v1/storage/clean-up { kinds: CleanKind[] (1..5, unique), closedMonths?: 3|6|12|24 }` → 202 `CleanupView`; 409 `CLEANUP_RUNNING` with the running one; `GET /api/v1/storage/clean-up/:id` → `CleanupView = { id; kinds; status: "running"|"done"|"failed"; filesPlanned; bytesPlanned; filesDone; bytesDone; startedAt; finishedAt }`; `GET /api/v1/storage/clean-up/:id/files.csv` (the list, kind, lead id, file kind, size, date; formula-safe).
- Produces: `runCleanup(o: { pool; store; log; now }, id: string): Promise<void>`.

What each kind does, in batches of 1000 rows per transaction, until done:
- closed / trash / old: `whatsapp_media` and `instagram_media` rows → `status = 'removed'`, `sha256 = NULL`, `problem = 'LUME cleared this file to make room on the server. It's still on the phone.'` (Instagram: `…It's still in Instagram.`).
- previews: delete the `file_previews` rows (opening the file again makes the preview again: the viewer already queues a missing one).
- library: delete archived `message_files` rows no template (whatsapp_template_submissions.header_file_id) points at.
- After all: `sweepWhatsAppFiles({ …, minAgeMs: 0 })` so the bytes leave the disk now; `bytes_done`/`files_done` move as each batch commits (a file's bytes count when its row's refs reach zero, measured by the sweep's deletions).

- [ ] **Step 1: Write the failing tests**:
  - `it("clears the ticked kinds only; the words of every message stay; the bytes leave the disk at once")`: after the job, the WhatsApp message on the closed lead shows status `removed` with the words above, the file is gone from `store`, an open lead's file is untouched, `bytesDone === bytesPlanned`.
  - `it("a file another lead still holds stays on disk")` (Review Focus 1).
  - `it("one at a time: a second press is told and shown the running one")` (Review Focus 3): 409 `CLEANUP_RUNNING`, body carries the running id.
  - `it("a file attached again mid-clean stays")` (Review Focus 2): a beforeSweep hook inserts a new media row with the same sha256 → the file remains on disk and in whatsapp_files.
  - `it("big: 5,000 rows clear in batches of 1000")`: count transactions via a test hook (or assert `files_done` rose in 5 steps).
  - `it("audited, and the file list downloads formula-safe")`: audit row `storage.cleaned` with kinds/files/bytes; CSV first line headers, a lead name starting with `=` is escaped.
- [ ] **Step 2: Run them, see them fail.**
- [ ] **Step 3: Implement** the route (zod strict body; plan with `survey()` for `files_planned`/`bytes_planned`; insert the row (unique running index → 409); enqueue `storage.cleanup`), `runCleanup`, the queue (1 worker, retryLimit 3), the CSV.
- [ ] **Step 4: Run them, see them pass**; mutate the batch LIMIT, the open-lead exclusion, the 409 guard and the `minAgeMs: 0` sweep: all killed.
- [ ] **Step 5: Commit** `feat(storage): clean up what LUME can give back`.

### Task 3: The suggestion and the settings

**Files:**
- Create: `apps/api/src/modules/storage/suggest.ts`
- Modify: `apps/api/src/modules/storage/routes.ts`, `apps/api/src/modules/health/service.ts` (disk_full action → `{ label: "Clean up", href: "/settings/storage" }`), `apps/api/src/modules/whatsapp/keep.ts` (the keep-for months also clear Instagram media), the hourly job that runs `sweepWhatsApp` (call `suggestStorage`)
- Test: `apps/api/src/modules/storage/suggest.test.ts`

**Interfaces:**
- Produces: `PUT /api/v1/storage/settings { warnAtPct?: 70|80|90; keepFilesMonths?: 3|6|12|24|null }` (settings.manage, audited `storage.settings`); stored as `settings.integrations.storage.warnAtPct`, keep-for stays `integrations.whatsapp.keepFilesMonths` (one setting, now for both channels).
- Produces: `suggestStorage(pool: pg.Pool, files: FilesDeps | undefined, now: Date): Promise<boolean>` (true when it told the admins).

- [ ] **Step 1: Write the failing tests**:
  - `it("past the mark with room to give back: the admins hear once a day, with how much")`: disk at 82%, candidates 20.7 GB → one `system_alert` per admin titled `The server is 82% full`, body `LUME can give back 20.7 GB. Nothing on an open lead.`, data href `/settings/storage`; a second call the same day → nothing; next day → again.
  - `it("under the mark, or nothing to give back: nothing")`.
  - `it("the keep-for months clear Instagram files too")`.
  - `it("settings change within the choices, audited; others refused")`: `warnAtPct: 75` → 400.
- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass; mutate the once-a-day guard and the mark comparison: killed.**
- [ ] **Step 5: Commit** `feat(storage): suggest a clean up when the disk fills`.

### Task 4: Settings › Storage (the page and the morph)

**Files:**
- Create: `apps/web/src/app/(app)/settings/storage/page.tsx`, `apps/web/src/components/settings/storage/StoragePage.tsx`, `CleanUpSheet.tsx`, `CleanUpMorph.tsx`, `storage.module.css`, `apps/web/src/lib/settings/storage.ts`
- Modify: `apps/web/src/lib/settings/areas.ts` (`{ id: "storage", title: "Storage", blurb: "What LUME keeps on this server, and room to clear", href: "/settings/storage", anyOf: ["settings.manage"], group: "workspace" }` after Media)
- Test: `StoragePage.test.tsx`, `CleanUpSheet.test.tsx`, `CleanUpMorph.test.tsx`

**Interfaces:**
- Consumes: the API of Tasks 1–3; `RefreshMorph`, `layer`, `Tick` from `components/ui/RefreshMorph.tsx`; `SettingsPage`.
- Produces: `storageClient.get(closedMonths)`, `.clean(kinds, closedMonths)`, `.progress(id)`, `.settings(patch)`, `filesCsvUrl(id)`.

Copy and layout exactly as the approved canvas: title `Storage`, lede `What LUME keeps on this server, and the room it can give back.`, the disk line `81.8 GB of 100 GB used` + pill (`Getting full` at the mark or over, else `Plenty of room`), one bar in five segments, the key, groups `LUME can give back 20.7 GB` (with `Nothing on a lead you're still working.`), `What's here`, `On its own`; the sheet `Clean up` / `Tick what can go. You see what it gives back before anything is cleared.`, rows with size and count, the warning on `Every chat file older than 12 months` (`This includes leads your team is still working.`), `Never cleared: …`, footer `Gives back` total, `List the files first`, `Clear 20.7 GB`. The morph: pill `Giving back 20.7 GB…`, card with seven file tiles leaving one by one as `bytesDone/bytesPlanned` rises (polled every 700 ms), drain bar from the disk's used share down, `Giving back 8.4 GB`, `3,214 files cleared · the disk at 74%`; result `20.7 GB` / `back on this server · 61% full`; face `20.7 GB back`; the page re-reads the survey on landing.

- [ ] **Step 1: Write the failing tests**:
  - Page: renders the canvas copy from a fixture; a disk of `null` shows `LUME can't read this disk's size` instead of the bar (Review Focus 4); `LUME can give back` group absent when every candidate is 0.
  - Sheet: default ticks closed, trash, previews; toggling updates `Gives back`; nothing ticked disables Clear with `Tick something to clear`; the old-files warning shows only when ticked.
  - Morph: phases idle → lifting → syncing → result → landing → landed with `20.7 GB back`; Reduce Motion: the still card; a 409 shows the running clean-up's progress instead of an error.
- [ ] **Step 2: Run, fail. Step 3: Implement** (module CSS with `min-width: 0` on every flex child that holds text, `text-overflow: ellipsis` on row titles with the full title in `title`, sizes `white-space: nowrap`, the page `max-width: 760px`). **Step 4: Run, pass.**
- [ ] **Step 5: Commit** `feat(storage): Settings › Storage, and Clean up`.

### Task 5: End to end, and nothing overflows

**Files:**
- Create: `apps/web/e2e/storage.spec.ts`
- Test: itself

- [ ] **Step 1: Write the test**: an admin opens Settings › Storage, opens Clean up, clears the default ticks, sees the morph land on `GB back`, and the disk line falls; at widths 375, 768, 1280 and 1440, in Porcelain and Obsidian, `document.scrollingElement.scrollWidth <= innerWidth` on the page and with the sheet open, and no element under `[data-storage]` has `scrollWidth > clientWidth + 1` except the ones allowed to scroll; axe finds nothing.
- [ ] **Step 2: Run it** on the box (one job at a time): pass.
- [ ] **Step 3: Full gate** (`dev.sh test-db clean` first), fresh review, fixes, push. **Commit** `test(storage): end to end, at every width`.
