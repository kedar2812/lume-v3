# Live sheets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LUME makes a Google Sheet in the client's Drive and keeps it filled with the leads a rule picks (Meta audience
preset or own columns), with a Live sheets page, a four-step form, a real progress bar and the same sync rhythm as
lead fetching.

**Architecture:** Pure rule, row and diff logic in `packages/core/src/live-sheets/`; tables in migration 0109; an API
module `apps/api/src/modules/live-sheets/` that owns the Google writes, a pg-boss queue (`live-sheets.sync`) ticked
like `sheets.sync`, and routes; progress on the existing stream through a new `lume_live_sheets` channel; web screens in
`apps/web/src/components/live-sheets/` and the page `/live-sheets`. Every sync is one idempotent reconcile: desired
rows from LUME, compared with what LUME last wrote, written in batches, each row found in Google by developer metadata.

**Tech Stack:** TypeScript, Fastify + Zod, Drizzle + Postgres (FORCE RLS), pg-boss, Next.js App Router, React 19,
Motion (`motion/react`), Vitest, Playwright, the fake Google (`apps/api/test/google-fake.ts`), the relay
(`apps/connect`).

**Spec:** `docs/superpowers/specs/2026-11-14-live-sheets-design.md` (approved by the owner 2026-11-14). Read it with
this plan; it holds the copy, the states and the owner's decisions.

## Global Constraints

- Ships as **1.4.0**, after 1.3.1. Migration **0109** (0108 is 1.3.1's audit.export).
- Google scope stays `https://www.googleapis.com/auth/drive.file`. No other scope, anywhere.
- New permission key `leads.live_sheets`, group `Leads`, label `Make live sheets`, description
  `Google Sheets LUME keeps up to date`, unscoped. Every live sheet route and screen also needs `leads.export`.
- New tier feature `live_sheets`, first tier `pro`. Pro's `TIER_LINES` gain `Live sheets for Meta audiences`.
- At most **20** live sheets per business (`deleted_at IS NULL`).
- Sync rhythm: `poll_seconds` default **120**, back-off `min(poll * 2^failures, 1 h)`, tick every 60 s, held back by
  `heldBack(app, "scheduled live sheet syncs")` exactly as `sheets/queue.ts`.
- Writes: at most **500 rows** per Google request; at most one run per sheet at a time.
- Header style: background `#2A5BFF`, white bold text, row 1 frozen. Empty cells: background `#EEF1F6`, value empty
  (never "N/A").
- Second tab title: `Made with LUME`. Mark: the official `apps/web/public/lume-mark.png`, untouched, via
  `=IMAGE("<instance origin>/lume-mark.png")`. Text: `Kept up to date by LUME · lumecrm.in`. Nothing about Meta.
- Meta columns, in order: `email`, `phone`, `fn`, `ln`, `country`, then `value` only when the rule includes a won stage.
- Copy speaks as LUME, no em dashes, no client names (`scripts/check-copy.mjs`, `scripts/check-client-names.mjs`).
- Screens: Porcelain and Obsidian, 375 px, keyboard, screen-reader names, reduced motion, full-window scrim, loading
  bar + skeletons, apple-design springs (`bounce: 0`, `duration` 0.3 to 0.5) and no layout jumps.
- Every guard gets a mutation check written in the ledger (`docs/QUALITY_PROCESS.md` §3). Full gate on the build box
  before each push.

## Review Focus

1. **A first fill of 13,000+ leads where Google answers 429 mid-way** must finish with every lead exactly once and the
   bar never moving backwards. (Task 5 test `fills past a 429 without a duplicate row`.)
2. **"Keep them" after a person sorts the sheet and edits one cell, then the lead changes in LUME:** the edited cell
   stays, the lead's other cells update in its moved row. (Task 5 test `keeps a hand edit in a sorted sheet`.)
3. **Refresh, the tick and Update now landing together** must make one run and no doubled rows. (Task 6 test
   `three triggers at once make one run`.)
4. **The maker deletes their account or is offboarded:** the sheet pauses (`maker_gone`), admins are told, a lead
   deleted from LUME still leaves the sheet while it's paused (privacy pass). (Task 6 test
   `a deleted lead leaves a paused sheet`.)
5. **A lead with a phone LUME can't place in a country, a one-word name, or a 300-character custom field:** Meta row
   has `country` empty and shaded, `fn` only, long text cut at Google's 50,000-character cell limit. (Task 1 tests.)

---

### Task 1: The rule, the rows and the diff (pure, in core)

**Files:**
- Create: `packages/core/src/live-sheets/rule.ts`, `packages/core/src/live-sheets/rows.ts`,
  `packages/core/src/live-sheets/diff.ts`, `packages/core/src/live-sheets/words.ts`,
  `packages/core/src/live-sheets/live-sheets.test.ts`
- Modify: `packages/core/src/shared.ts` (export the four), `packages/core/src/rbac/catalog.ts` (the permission),
  `packages/core/src/licence/tiers.ts` (feature + Pro line), `packages/core/src/rbac/rbac.test.ts`,
  `packages/core/src/licence/tiers.test.ts`

**Interfaces:**
- Produces:
  - `type LiveSheetPreset = "meta" | "own"`; `type StageRule = { mode: "reached" | "in"; stageIds: string[] }`
  - `type LiveSheetRule = { stages: StageRule; sourceIds?: string[]; tagIds?: string[]; ownerIds?: string[];
    teamIds?: string[]; addedOnOrAfter?: string /* YYYY-MM-DD */; includeMissing: boolean; includeDnc: boolean;
    backfill: boolean }`
  - `const liveSheetRuleSchema` (zod; `stageIds` 1 to 20 uuids, the arrays up to 50 uuids)
  - `const META_COLUMNS = ["email", "phone", "fn", "ln", "country"] as const` and `metaColumns(includesWon: boolean)`
  - `splitName(name: string): { fn: string; ln: string }`, `countryOfPhone(digits: string): string | null`
  - `type SheetCell = string | number | null`; `type SheetRow = { leadId: string; cells: SheetCell[] }`
  - `cellText(v: SheetCell): string` (cuts at 50,000 characters)
  - `type Written = { leadId: string; hash: string; cells: SheetCell[]; editedCols: number[]; removedByHand: boolean }`
  - `type WritePlan = { add: SheetRow[]; update: { leadId: string; cells: SheetCell[]; skipCols: number[] }[];
    remove: string[] /* leadIds */ }`
  - `planWrites(o: { desired: SheetRow[]; written: Written[]; edits: "keep" | "replace"; ruleMode: "reached" | "in";
    deleted: Set<string> }): WritePlan`
  - `rowHash(cells: SheetCell[]): string` (sha256 hex of the JSON)
  - `ruleWords(rule: LiveSheetRule, names: { stage(id): string; source(id): string; tag(id): string;
    person(id): string; team(id): string }): string`

- [ ] **Step 1: Write the failing tests** in `live-sheets.test.ts`:
  - `splitName("Riya Sharma")` → `{ fn: "Riya", ln: "Sharma" }`; `splitName("Riya")` → `{ fn: "Riya", ln: "" }`;
    `splitName("  Ana  de la Cruz ")` → `{ fn: "Ana", ln: "de la Cruz" }`.
  - `countryOfPhone("919876543210")` → `"IN"`; `countryOfPhone("971501234567")` → `"AE"`; `countryOfPhone("12")` → `null`.
  - `metaColumns(false)` → `["email","phone","fn","ln","country"]`; `metaColumns(true)` ends with `"value"`.
  - `cellText("x".repeat(60000)).length` → `50000`.
  - `planWrites`: new desired lead → `add`; changed lead → `update` with `skipCols: []`; with `edits: "keep"` and
    `editedCols: [2]` → `skipCols: [2]`; `removedByHand: true` with keep → neither add nor update; with replace → add;
    lead gone from desired with `ruleMode: "reached"` → kept (no remove); with `"in"` → `remove`; lead in `deleted` →
    `remove` whatever the mode and the edits choice; unchanged hash → nothing.
  - `ruleWords` → `"Leads that reached Qualified, from Instagram"`, `"Leads in Won or Follow-up, owned by Riya Sharma"`,
    with `added on or after November 1` when set. No em dash in any output.
  - Catalog: `isPermissionKey("leads.live_sheets")`; `ALL_GRANTS` includes it.
  - Tiers: `tierAllows({ tier: "base" }, "live_sheets") === false`, `pro` true, no tier true;
    `TIER_LINES.pro` contains `"Live sheets for Meta audiences"`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run packages/core/src/live-sheets packages/core/src/licence packages/core/src/rbac'` → FAIL (modules missing).
- [ ] **Step 3: Implement** the four files and the catalog, tier and shared changes. `countryOfPhone` uses
  `libphonenumber-js` (already a core dependency) on `+${digits}`. `planWrites` order: `remove` first, then `update`,
  then `add` newest first.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Mutation check** `planWrites`'s deleted rule (make it respect `keep`): the deleted-lead test goes red.
  Restore. Ledger line.
- [ ] **Step 6: Commit** `feat(core): live sheets' rule, rows and write plan`.

### Task 2: The tables, the permission's grants and RLS

**Files:**
- Create: `packages/db/migrations/0109_live_sheets.sql`, `packages/db/src/schema/live-sheets.ts`,
  `packages/db/src/live-sheets.test.ts`
- Modify: `packages/db/src/schema/index.ts` (export)

**Interfaces:**
- Produces tables (Drizzle names in brackets):
  - `live_sheet_grants` [`liveSheetGrants`]: `id uuid pk`, `user_id uuid → users`, `google_email text`,
    `grant_enc bytea` (sealed refresh token, as `lead_sources.config`), `created_at`; unique `(user_id, google_email)`.
  - `live_sheets` [`liveSheets`]: `id`, `name text (1..100)`, `preset text ('meta'|'own')`, `rule jsonb`,
    `columns jsonb` (string ids as lead exports use: `name`, `email`, `custom:<key>`…), `edits text ('keep'|'replace')`,
    `grant_id → live_sheet_grants`, `spreadsheet_id text`, `url text`, `tab_id integer`, `made_by uuid`,
    `runs_as uuid`, `status text ('making'|'live'|'updating'|'paused')`, `pause_reason text null`
    (`google_disconnected|sheet_gone|maker_gone|tier|licence|paused_by_person`), `lead_count int`,
    `last_synced_at`, `next_sync_at`, `failures int`, `poll_seconds int default 120 check 60..3600`, `created_at`,
    `updated_at`, `deleted_at`.
  - `live_sheet_rows` [`liveSheetRows`]: `sheet_id`, `lead_id`, `hash text`, `cells jsonb`, `edited_cols int[]`,
    `removed_by_hand bool`, pk `(sheet_id, lead_id)`.
  - `live_sheet_runs` [`liveSheetRuns`]: `id`, `sheet_id`, `trigger text ('make'|'schedule'|'refresh'|'now'|'edit')`,
    `status text ('queued'|'running'|'done'|'failed')`, `total int`, `written int`, `error text null`, `started_at`,
    `finished_at`; partial unique index: one `queued|running` run per sheet.
- Migration also: insert permission `leads.live_sheets` (`ON CONFLICT DO NOTHING`) and grant it to every role holding
  `leads.export`, as `0030_queue_grant.sql` does. RLS on all four tables as `lead_sources` (business tables, FORCE).

- [ ] **Step 1: Failing test** `live-sheets.test.ts`: migration applies; `lume_app` can insert and read a sheet;
  a second `queued` run for one sheet violates the unique index; a role with `leads.export` holds
  `leads.live_sheets` after migrate; `poll_seconds` 30 is refused.
- [ ] **Step 2: Run** `npx vitest run packages/db/src/live-sheets.test.ts` → FAIL.
- [ ] **Step 3: Write** the migration and schema.
- [ ] **Step 4: Run** → PASS; also `npx vitest run packages/db` → PASS.
- [ ] **Step 5: Commit** `feat(db): live sheets' tables (0109)`.

### Task 3: Google: make, read and write a sheet (and the fake)

**Files:**
- Create: `apps/api/src/modules/live-sheets/google.ts`, `apps/api/src/modules/live-sheets/google.test.ts`
- Modify: `apps/api/src/modules/sheets/google.ts` (`GoogleWrite.method` adds `"PATCH"`), `apps/api/test/google-fake.ts`

**Interfaces:**
- Consumes: `googleCaller`, `GoogleError`, `isTransient` from `sheets/google.ts`; `refreshTokens` (the relay grant
  token source the calendar uses).
- Produces `liveSheetsGoogle(o: { tokens: TokenSource; fetch?; sleep? })` with:
  - `create(o: { title: string; header: string[]; markUrl: string; about: string[] }): Promise<{ spreadsheetId: string;
    url: string; tabId: number }>`: one `spreadsheets.create` with both tabs, then one `batchUpdate` for the header
    style, the frozen row and the `IMAGE()` cell.
  - `readTab(id: string, tabId: number): Promise<{ rows: { row: number; leadId: string | null; cells: string[] }[] }>`:
    values plus developer metadata (`lume.lead`) per row.
  - `write(id: string, tabId: number, plan: { add; update; remove }, onBatch: (rowsDone: number) => Promise<void>)`:
    removes by `deleteDimension` (bottom-up), updates by `values:batchUpdate` on found rows skipping `skipCols`, adds by
    `appendCells` + `createDeveloperMetadata` in batches of 500, shading empty cells `#EEF1F6`; calls `onBatch` after
    each confirmed batch.
  - `renameColumns(id, tabId, header: string[])`, `setAbout(id, lines: string[])`, `trash(id)` (Drive PATCH
    `trashed: true`), `exists(id): Promise<boolean>`.
- The fake keeps spreadsheets in memory with tabs, cells, formats and row metadata; can be told to answer 429 on the
  Nth write, 404 for a deleted file, and `invalid_grant` for a revoked token; can sort a tab (moving metadata with rows)
  and edit a cell, for tests.

- [ ] **Step 1: Failing tests** in `google.test.ts` against the fake: `create` makes two tabs named `<title>` and
  `Made with LUME`, header bold white on `#2A5BFF`, row 1 frozen, `B2` formula `=IMAGE("https://x.test/lume-mark.png")`;
  `write` of 1,200 adds sends 3 append requests and `onBatch` gets 500, 1000, 1200; after the fake sorts the tab,
  `update` lands in the moved row; a 429 on the second batch is retried and the tab ends with exactly 1,200 rows;
  `remove` deletes the right rows after a sort; `trash` sets the fake's trashed flag; a 404 throws `GoogleError` with
  `status 404`.
- [ ] **Step 2: Run** `npx vitest run apps/api/src/modules/live-sheets/google.test.ts` → FAIL.
- [ ] **Step 3: Implement** `google.ts` and the fake's new endpoints.
- [ ] **Step 4: Run** → PASS; `npx vitest run apps/api/src/modules/sheets` still PASS.
- [ ] **Step 5: Commit** `feat(live-sheets): make, read and write a Google Sheet`.

### Task 4: Connecting Google for live sheets (relay + instance)

**Files:**
- Modify: `apps/connect/src/relay.ts`, `apps/connect/src/relay.test.ts`
- Create: `apps/api/src/modules/live-sheets/connect.ts`, `apps/api/src/modules/live-sheets/connect.test.ts`,
  `apps/web/src/app/(app)/live-sheets/connected/page.tsx`

**Interfaces:**
- Relay: `/start` accepts `k=live_sheet` (signed with the nonce like `calendar`), asks for `drive.file` only, with no
  Picker; `/callback` seals `{ nonce, refreshToken, kind: "live_sheet", email, exp }` and redirects to
  `<instance>/live-sheets/connected?p=&s=`. The email comes from Google's `userinfo`-free route: the Drive `about`
  call with `fields=user(emailAddress)` (allowed under `drive.file`).
- Instance: `liveSheetConnectStart(req, d): Promise<{ url: string }>` (oauth_connects kind `live_sheet`);
  `liveSheetConnectComplete(req, d, { p, s }): Promise<{ grantId: string; email: string }>` (verify, unseal, nonce
  locked `FOR UPDATE`, upsert `live_sheet_grants` by `(user, email)`).
- `oauth_connects.kind` type gains `"live_sheet"` (TS only; the column is text).

- [ ] **Step 1: Failing tests**: relay `start with k=live_sheet asks only for drive.file and no Picker`; a
  `live_sheet` link can't be replayed as `calendar` (signature); callback hands back to `/live-sheets/connected`.
  Instance: complete twice → second `CONNECT_NOT_FOUND`; expired → `CONNECT_EXPIRED`; a calendar hand-back refused;
  same Google account twice → one grant row.
- [ ] **Step 2: Run** `npx vitest run apps/connect apps/api/src/modules/live-sheets/connect.test.ts` → FAIL.
- [ ] **Step 3: Implement.** The connected page mirrors `calendar/connected/page.tsx`: completes once, then returns to
  the form it came from (`?back=`), which resumes at step 4 with the account chosen.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Mutation check** the nonce lock (drop `FOR UPDATE` + `isNull(completedAt)`): the twice test goes red.
- [ ] **Step 6: Commit** `feat(live-sheets): connect Google for live sheets`.

### Task 5: The reconcile run

**Files:**
- Create: `apps/api/src/modules/live-sheets/run.ts`, `apps/api/src/modules/live-sheets/rows.ts`,
  `apps/api/src/modules/live-sheets/run.test.ts`

**Interfaces:**
- Consumes: Task 1 (`planWrites`, `rowHash`, `metaColumns`, `splitName`, `countryOfPhone`, `cellText`), Task 3
  (`liveSheetsGoogle`), `withJobRequest` (`imports/job-request.ts`), `leadFilters` + `loadFieldRegistry` +
  `columnsFor` (`leads/query.ts`, `lead-exports/make.ts`), `audit`.
- Produces:
  - `desiredRows(req: FastifyRequest, sheet: LiveSheetRecord): Promise<{ header: string[]; rows: SheetRow[];
    missing: number; includesWon: boolean }>`: the rule as SQL (`reached` = exists in `lead_stage_history` with the
    stage, or the lead's stage is it; `in` = the lead's stage), plus `leadFilters` for source, tag, owner, team, date
    and reach; do-not-contact out unless `includeDnc`; missing-contact leads out unless `includeMissing` (Meta);
    `backfill: false` keeps only leads that matched after `created_at`. Own columns use `columnsFor` with the runner's
    field access; a column whose field was archived stays with empty cells.
  - `runLiveSheet(o: { app; pool; google: (grant) => LiveSheetsGoogle; sheetId: string; runId: string;
    now: () => Date }): Promise<"done" | "failed" | "paused">`: under `pg_try_advisory_xact_lock(hashtext(sheetId))`;
    checks the runner is active and still holds `leads.live_sheets` + `leads.export`, else pause `maker_gone`
    (after the privacy pass); tier (`tierAllows(plan, "live_sheets")`) else pause `tier`; licence held back else
    `licence`; reads the tab when `edits = "keep"` (detects hand edits by comparing with `live_sheet_rows.cells`, and
    rows whose metadata is gone as `removedByHand`); `planWrites`; `write` with `onBatch` updating
    `live_sheet_runs.written` and `pg_notify('lume_live_sheets', {sheet, kind: "progress"})`; stores each confirmed
    batch's rows in `live_sheet_rows` before the next batch; updates header and the About tab (rule words, count,
    `last updated`); sets `live`, `lead_count`, `last_synced_at`, `next_sync_at`, `failures = 0`.
  - Google errors: 401 after refresh / `invalid_grant` → pause `google_disconnected`; 404 or 403 on the file →
    `sheet_gone`; transient → run `failed`, `failures + 1`, `next_sync_at` backed off, status stays `live` with the
    Google-is-slow words on the card.
  - **Privacy pass:** a sheet paused for `maker_gone`, `tier`, `licence` or `paused_by_person` still removes deleted
    leads' rows on each tick when Google answers.

- [ ] **Step 1: Failing tests** (`run.test.ts`, harness + fake Google):
  - `makes the sheet and writes every matching lead` (Meta preset, 3 leads, 1 without phone or email → included and
    its email and phone cells shaded; header `email,phone,fn,ln,country`).
  - `leaves out leads with no phone or email when asked` (`includeMissing: false`), `leaves out do-not-contact by
    default`, `a won rule adds value`.
  - `reached keeps a lead that moved on; in removes it`.
  - `a deleted lead leaves the sheet` (both modes, keep and replace).
  - `keeps a hand edit in a sorted sheet` (Review Focus 2) and `put LUME's back overwrites it`.
  - `a row deleted by hand stays deleted with keep, comes back with replace`.
  - `fills past a 429 without a duplicate row` (Review Focus 1: 1,300 leads, fake 429 on batch 2; written counts
    reported 500, 1000, 1300, never lower).
  - `a revoked grant pauses as google_disconnected`, `a deleted file pauses as sheet_gone`.
  - `the maker loses export: pauses as maker_gone, and a deleted lead still leaves` (Review Focus 4).
  - `Base tier pauses as tier`; `a sheet only holds leads the runner can see` (rep with own scope).
  - `a 300-character custom field and a one-word name` (Review Focus 5).
- [ ] **Step 2: Run** `npx vitest run apps/api/src/modules/live-sheets/run.test.ts` → FAIL.
- [ ] **Step 3: Implement** `rows.ts` (`desiredRows`) and `run.ts` (`runLiveSheet`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Mutation checks:** drop the runner-permission check (maker test red); drop the privacy pass (deleted
  lead test red); write all batches before storing rows (429 test red). Restore; ledger.
- [ ] **Step 6: Commit** `feat(live-sheets): the reconcile run`.

### Task 6: Queue, schedule, Refresh and the stream

**Files:**
- Create: `apps/api/src/modules/live-sheets/queue.ts`, `apps/api/src/modules/live-sheets/queue.test.ts`
- Modify: `apps/api/src/app.ts` (start the queue beside `sheets` queue), `apps/api/src/modules/sheets/refresh.ts` and
  `refresh.test.ts` (Refresh requests live sheet runs and reports them), `apps/api/src/modules/notifications/hub.ts`
  (+ `lume_live_sheets` → `LiveSheetEvent`), `apps/api/src/modules/notifications/routes.ts` (stream sends it),
  `apps/web/src/lib/notifications/stream.ts` (+ `onLiveSheet`)

**Interfaces:**
- `requestRun(tx, o: { sheetId; trigger: RunTrigger; requestedBy: string | null }): Promise<{ runId; fresh: boolean }>`
  (insert, or return the queued/running one via the unique index; `fresh: false` when joined).
- `liveSheetQueue(o: { app; pool; boss; tickMs?: number; google })` → `{ tick(): Promise<number>; enqueue(id) }`;
  start-up closes runs cut off by a restart, as `sheets/queue.ts` does.
- `type LiveSheetEvent = { sheet: string; kind: "progress" | "status" | "reconnected" }`.
- Refresh response (`RefreshProgress`) gains `liveSheets: { total: number; done: number }`; result line words:
  `· 2 live sheets updated` (web `resultLine`).

- [ ] **Step 1: Failing tests**: `three triggers at once make one run` (Review Focus 3); `a due sheet runs on the tick,
  a paused one only gets its privacy pass`; `licence lock holds scheduled runs, a queued one finishes`; refresh test
  `Refresh asks live sheets to update and counts them`; hub test `a live sheet event reaches its business's streams
  only for people with leads.live_sheets`.
- [ ] **Step 2: Run** `npx vitest run apps/api/src/modules/live-sheets apps/api/src/modules/sheets/refresh.test.ts apps/api/src/modules/notifications` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(live-sheets): schedule, Refresh and live progress`.

### Task 7: Routes, audit words and the access matrix

**Files:**
- Create: `apps/api/src/modules/live-sheets/routes.ts`, `apps/api/src/modules/live-sheets/service.ts`,
  `apps/api/src/modules/live-sheets/routes.test.ts`
- Modify: `apps/api/src/app.ts` (register), `apps/api/test/probes.ts`, `packages/core/src/audit/words.ts`,
  `apps/web/src/lib/settings/audit.test.ts` (WRITTEN list)

**Interfaces (all `config: { permission: "leads.live_sheets" }`, then `leads.export` and the tier checked in words):**
- `GET /api/v1/live-sheets` → `{ sheets: LiveSheetView[] }` (`id, name, preset, ruleWords, status, pauseReason, url,
  leadCount, lastSyncedAt, run: { total, written } | null, madeBy: { id, name }, edits`)
- `POST /api/v1/live-sheets/count` body `{ preset, rule }` → `{ matching: number; missingContact: number }`
- `POST /api/v1/live-sheets` body `{ name, preset, rule, columns, edits, grantId }` → `201 { sheet }` (starts the
  `make` run); refusals: `LIVE_SHEETS_TIER` (Base), `LIVE_SHEETS_FULL` (20), `NO_EXPORT_ACCESS`, `GRANT_NOT_YOURS`,
  `COLUMN_HIDDEN`, `CONTACTS_MASKED` (the Meta preset, or an email or phone column, for someone who sees contacts
  masked: "A live sheet needs phone numbers and emails in full. Your role sees them masked."). The run treats a runner
  who loses full contacts the same way (pause `maker_gone`).
- `PATCH /api/v1/live-sheets/:id` (same body, partial) → starts an `edit` run that rewrites the tab.
- `POST /api/v1/live-sheets/:id/run`, `/pause`, `/resume`, `/take-over`; `DELETE /api/v1/live-sheets/:id?trash=1`.
- `POST /api/v1/live-sheets/connect/start`, `POST /api/v1/live-sheets/connect/complete`, `GET
  /api/v1/live-sheets/grants` (the person's own Google accounts).
- Audit actions with words: `live_sheet.created` ("made the live sheet “X”"), `live_sheet.edited`, `live_sheet.paused`,
  `live_sheet.resumed`, `live_sheet.deleted`, `live_sheet.taken_over`, `live_sheet.filled` ("wrote 3,000 leads to
  “X”").

- [ ] **Step 1: Failing tests**: each refusal above in its words; a viewer without the permission gets 403;
  `take-over` only for someone holding `users.manage` or the owner; a hidden column refused; `count` matches the run's
  rows for the same rule; every action audited once; probes added so `test/matrix.test.ts` passes.
- [ ] **Step 2: Run** `npx vitest run apps/api/src/modules/live-sheets/routes.test.ts apps/api/test/matrix.test.ts packages/core apps/web/src/lib/settings` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Mutation check** the export check and the 20 limit; ledger.
- [ ] **Step 6: Commit** `feat(live-sheets): routes`.

### Task 8: The Live sheets page

**Files:**
- Create: `apps/web/src/app/(app)/live-sheets/page.tsx`, `apps/web/src/components/live-sheets/LiveSheetsScreen.tsx`,
  `LiveSheetCard.tsx`, `SheetProgress.tsx`, `CopyLink.tsx`, `live-sheets.module.css`, and tests beside each
  (`*.test.tsx`); `apps/web/src/lib/live-sheets/client.ts`, `types.ts`
- Modify: `apps/web/src/components/shell/nav.ts` (+ item `live-sheets` after `pipeline`, icon `livesheets`,
  permission `leads.live_sheets`), `apps/web/src/components/shell/icons.tsx`, `nav.test.ts`, `Sidebar.test.tsx`

**Interfaces:**
- `liveSheetsClient` with `list, count, create, edit, run, pause, resume, takeOver, remove, connectStart,
  connectComplete, grants` (typed to Task 7).
- `<SheetProgress total written phase="making"|"writing"|"live"|"slow" />`: the bar only grows (keeps the max it has
  shown), words under it per spec §5, `role="progressbar"` with `aria-valuenow`, the tick draws itself on `live`.
- `<CopyLink url />`: copies, swaps to a tick and "Copied" for 2 s, announces via `role="status"`.

- [ ] **Step 1: Failing tests**: empty state with Create; cards show rule words, status, count, "updated 2 minutes
  ago", the link and Copy link (clipboard mocked, "Copied" announced); Paused card shows the reason and its fix button
  for each `pauseReason`; a stream `progress` event moves the bar without a reload; the bar never goes backwards when
  `written` arrives lower; Base tier shows the locked explanation (`Live sheets come with Pro.` + Ask about Pro when
  `canAsk`); Google Sheets off shows how to switch it on; nav shows the item only with the permission.
- [ ] **Step 2: Run** `npx vitest run apps/web/src/components/live-sheets apps/web/src/components/shell` → FAIL.
- [ ] **Step 3: Implement** with the apple-design skill: cards enter with a short stagger, status changes cross-fade,
  the bar fills with a spring, reduced motion fades only; loading bar and skeleton cards; both themes.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(live-sheets): the Live sheets page`.

### Task 9: The form (four steps, connect, progress)

**Files:**
- Create: `apps/web/src/components/live-sheets/CreateLiveSheet.tsx`, `steps/Purpose.tsx`, `steps/Leads.tsx`,
  `steps/Columns.tsx`, `steps/Finish.tsx`, `form.module.css`, `CreateLiveSheet.test.tsx`

**Interfaces:**
- `<CreateLiveSheet open onClose prefill?: { stageIds?: string[]; filters?: LeadsFilterState; sheet?: LiveSheetView } />`
  (`sheet` = Edit). Uses `Dialog` (full-window scrim), a step header ("Step 2 of 4"), back arrow, steps sliding with a
  spring in the direction of travel; columns reorder by drag and by keyboard (move up/down buttons).
- Step 2's count calls `count` debounced 300 ms, the number rolling with `Odometer`.
- Finish: name, the edits choice (two radio cards with one line each, spec §2.4), Google account picker or Connect
  Google (opens the relay link; returns via `/live-sheets/connected?back=`), Make the live sheet → the step becomes
  `<SheetProgress>` then the done state with `<CopyLink>` and Open in Google Sheets; closing mid-way keeps it running.

- [ ] **Step 1: Failing tests**: Meta preset shows its five columns read-only and the consent line; own columns lists
  only fields the person may see; prefill from a stage selects it; `includeMissing` on by default and its count line
  ("40 have no phone or email"); Make sends exactly the chosen body; the progress view follows stream events to done
  and shows the link; Edit opens with the sheet's values and PATCHes; keyboard-only path through all four steps.
- [ ] **Step 2: Run** `npx vitest run apps/web/src/components/live-sheets/CreateLiveSheet.test.tsx` → FAIL.
- [ ] **Step 3: Implement** with the apple-design skill.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(live-sheets): the form`.

### Task 10: The buttons on Leads and Pipeline

**Files:**
- Modify: `apps/web/src/components/leads/LeadsScreen.tsx`, `apps/web/src/components/board/BoardScreen.tsx` (top bar
  button and each stage column's menu item `Live sheet for this stage`), their tests

**Interfaces:**
- A `CreateLiveSheetButton` (in `components/live-sheets/`) placed beside `RefreshButton`: shown with
  `leads.live_sheets` + `leads.export`; on Base it opens the locked explanation instead of the form; with Google
  Sheets off it says how to switch it on. Leads passes its current filters as `prefill.filters`; a stage menu passes
  `prefill.stageIds: [stage.id]`.

- [ ] **Step 1: Failing tests**: the button is absent without the permission; Leads prefill carries the stage and
  source filters; the stage menu opens the form on step 1 with that stage chosen; Base shows the lock.
- [ ] **Step 2: Run** `npx vitest run apps/web/src/components/leads apps/web/src/components/board` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(live-sheets): Create a live sheet on Leads and Pipeline`.

### Task 11: End to end, screens and the release

**Files:**
- Create: `apps/web/e2e/live-sheets.spec.ts`
- Modify: `apps/web/e2e/a11y.spec.ts`, `apps/web/e2e/visual.spec.ts`, `apps/web/e2e/spills.ts` (the page and the form
  in their lists), `apps/web/e2e/api-server.mjs` (fake Google already wired; add the mark URL), `CHANGELOG.md`
  (1.4.0), `package.json` (1.4.0)

- [ ] **Step 1: Write** `live-sheets.spec.ts` against the real stack and the fake Google: from a Pipeline stage →
  Connect Google (fake relay) → Meta preset → Make → the bar reaches Live → Copy link → the fake sheet has the header,
  the rows, shaded empties, both tabs and the IMAGE formula; move a lead into the stage → Refresh → its row appears;
  delete a lead → its row leaves; Keep them + a hand edit in the fake → survives an update; revoke the fake grant →
  the card says Google disconnected with Connect again; Delete with "move it to Google's bin".
- [ ] **Step 2: Run** `cd apps/web && pnpm exec playwright test e2e/live-sheets.spec.ts` → PASS after Tasks 1 to 10
  (it fails first on the missing page).
- [ ] **Step 3: Add** the page, the form's four steps and the progress state to a11y (both themes), visual (both
  themes, 375 px and desktop) and spills; regenerate baselines **only from a full run**.
- [ ] **Step 4: CHANGELOG 1.4.0** in LUME's words (the page, the form, the Meta columns, the link, the sync and
  Refresh, the edits choice, Pro and up, migration 0109, relay update), version `1.4.0`.
- [ ] **Step 5: Full gate** (every row of `docs/QUALITY_PROCESS.md` §4) on the build box, judged by exit codes.
- [ ] **Step 6: Review** the whole diff against the spec and this plan; fix findings test-first.
- [ ] **Step 7: Commit and push** `release: 1.4.0`; tag `v1.4.0` after CI is green. **No deploy** (instances or the
  relay) until the owner says so.
- [ ] **Step 8: After the owner's deploy go-ahead:** relay first (`apps/connect`), then staging walks and the fleet
  update as for 1.3.1; then one real Meta test upload of a Meta-preset sheet (the owner or the ads person), and any
  column name Meta doesn't recognise is fixed in `metaColumns` as a 1.4.x.
